const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

/* =========================================================
   ENV
========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing");
if (!SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
if (!OWNER_PASSWORD) throw new Error("OWNER_PASSWORD is missing");

const OWNER_TELEGRAM_ID = 8256722518;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/* =========================================================
   SESSION
========================================================= */

const sessions = new Map();

function getSession(chatId) {
  return sessions.get(chatId);
}

function setSession(chatId, data) {
  sessions.set(chatId, {
    ...(sessions.get(chatId) || {}),
    ...data
  });
}

function clearSession(chatId) {
  sessions.delete(chatId);
}

function sessionIsAuthenticated(chatId, userId) {
  const session = getSession(chatId);
  return Boolean(
    session &&
      session.loggedIn === true &&
      Number(session.authUserId) === Number(userId)
  );
}

function isOwner(admin) {
  return admin?.role === "owner";
}

function generateTestCode() {
  return `PA-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;

  const [h, m] = value.split(":").map(Number);

  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

async function getApplicationOwnerId() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "owner")
    .limit(2);

  if (error) {
    throw new Error(
      `Could not find application owner: ${error.message}`
    );
  }

  if (!data || data.length !== 1) {
    throw new Error(
      data?.length
        ? "There must be exactly one application owner before creating tests."
        : "No application owner exists. Set your PrepArena application account as owner first."
    );
  }

  return data[0].id;
}

async function requireAuthenticatedSession(chatId, userId) {
  if (sessionIsAuthenticated(chatId, userId)) return true;

  clearSession(chatId);
  await startLogin(chatId, userId);

  return false;
}

/* =========================================================
   TELEGRAM HELPERS
========================================================= */

const PREFIX = "pa:";

async function send(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...options
    });
  } catch (error) {
    console.error("sendMessage error:", error.message);
    return null;
  }
}

async function editMessage(chatId, messageId, text, options = {}) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      ...options
    });
  } catch {
    return send(chatId, text, options);
  }
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "📝 Tests",
          callback_data: `${PREFIX}tests`
        },
        {
          text: "📚 Subjects",
          callback_data: `${PREFIX}subjects`
        }
      ],
      [
        {
          text: "👥 Admins",
          callback_data: `${PREFIX}admins`
        },
        {
          text: "❓ Help",
          callback_data: `${PREFIX}help`
        }
      ],
      [
        {
          text: "🚪 Logout",
          callback_data: `${PREFIX}logout`
        }
      ]
    ]
  };
}

function backKeyboard(callback = "panel") {
  return {
    inline_keyboard: [
      [
        {
          text: "⬅️ Back",
          callback_data: `${PREFIX}${callback}`
        }
      ]
    ]
  };
}

/* =========================================================
   PASSWORD
========================================================= */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash).split(":");

    if (parts.length !== 2) return false;

    const salt = parts[0];
    const stored = Buffer.from(parts[1], "hex");

    const derived = crypto.scryptSync(password, salt, 64);

    return (
      stored.length === derived.length &&
      crypto.timingSafeEqual(stored, derived)
    );
  } catch {
    return false;
  }
}

/* =========================================================
   OWNER BOOTSTRAP
========================================================= */

async function ensureOwnerAccount() {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("*")
    .eq("telegram_user_id", OWNER_TELEGRAM_ID)
    .maybeSingle();

  if (error) {
    console.error("Owner lookup error:", error);
    return;
  }

  if (!data) {
    const { error: insertError } = await supabase
      .from("telegram_admins")
      .insert({
        telegram_user_id: OWNER_TELEGRAM_ID,
        role: "owner",
        password_hash: hashPassword(OWNER_PASSWORD),
        is_active: true
      });

    if (insertError) {
      console.error("Owner insert error:", insertError);
    } else {
      console.log("Owner account created.");
    }

    return;
  }

  if (
    data.role !== "owner" ||
    data.is_active !== true
  ) {
    const { error: updateError } = await supabase
      .from("telegram_admins")
      .update({
        role: "owner",
        is_active: true,
        updated_at: new Date().toISOString()
      })
      .eq("telegram_user_id", OWNER_TELEGRAM_ID);

    if (updateError) {
      console.error("Owner update error:", updateError);
    }
  }
}

/* =========================================================
   AUTH
========================================================= */

async function getAdmin(telegramUserId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("Admin lookup:", error);
    return null;
  }

  return data || null;
}

async function requireAuth(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const admin = await getAdmin(userId);

  if (!admin) {
    await send(
      chatId,
      "⛔ <b>Access Denied</b>\n\nYou are not authorized to use the PrepArena Admin Bot."
    );

    return null;
  }

  return admin;
}

async function requireCallbackAuth(query) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;

  if (!userId || !chatId) {
    await bot
      .answerCallbackQuery(query.id, {
        text: "Invalid request.",
        show_alert: true
      })
      .catch(() => {});

    return null;
  }

  if (!sessionIsAuthenticated(chatId, userId)) {
    await bot
      .answerCallbackQuery(query.id, {
        text: "Please authenticate first.",
        show_alert: true
      })
      .catch(() => {});

    await startLogin(chatId, userId);

    return null;
  }

  const admin = await getAdmin(userId);

  if (!admin) {
    clearSession(chatId);

    await bot
      .answerCallbackQuery(query.id, {
        text: "Access denied.",
        show_alert: true
      })
      .catch(() => {});

    await send(
      chatId,
      "⛔ <b>Access Denied</b>\n\nYour admin account is inactive or no longer exists."
    );

    return null;
  }

  return admin;
}

/* =========================================================
   LOGIN
========================================================= */

async function startLogin(chatId, userId) {
  const admin = await getAdmin(userId);

  if (!admin) {
    await send(
      chatId,
      "⛔ <b>Access Denied</b>\n\nThis Telegram account is not registered as an admin."
    );

    return;
  }

  setSession(chatId, {
    loggedIn: false,
    authUserId: userId,
    state: "password"
  });

  await send(
    chatId,
    "🔐 <b>Admin Authentication</b>\n\nEnter your password:"
  );
}

async function processPassword(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = getSession(chatId);

  if (!session || session.state !== "password") {
    return false;
  }

  const admin = await getAdmin(userId);

  if (!admin) {
    clearSession(chatId);

    await send(chatId, "⛔ Access denied.");

    return true;
  }

  if (!verifyPassword(msg.text.trim(), admin.password_hash)) {
    await send(
      chatId,
      "❌ Incorrect password.\n\nTry again or use /cancel."
    );

    return true;
  }

  setSession(chatId, {
    loggedIn: true,
    authUserId: userId,
    adminRole: admin.role,
    state: null
  });

  await send(
    chatId,
    "✅ <b>Authentication successful.</b>",
    {
      reply_markup: mainKeyboard()
    }
  );

  return true;
}

/* =========================================================
   PANEL
========================================================= */

async function showPanel(chatId) {
  await send(
    chatId,
    "🛠️ <b>PrepArena Admin Panel</b>\n\nChoose an action:",
    {
      reply_markup: mainKeyboard()
    }
  );
}

/* =========================================================
   HELP
========================================================= */

async function showHelp(chatId) {
  await send(
    chatId,
    `❓ <b>PrepArena Admin Bot</b>

<b>Tests</b>
• Create and manage tests
• Configure test details
• Add/edit/delete questions
• Manage subjects
• Publish tests
• End tests

<b>Admins</b>
• Owner can add admins
• Owner can enable/disable admins
• Owner can remove admins
• Owner can change admin passwords

<b>Authentication</b>
• Every admin must authenticate
• Sessions are bound to the Telegram user
• Inactive admins cannot access the bot

Use /cancel to cancel the current operation.`,
    {
      reply_markup: backKeyboard()
    }
  );
}
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

function statusEmoji(status) {
  switch (status) {
    case "published":
      return "🟢";
    case "draft":
      return "🟡";
    default:
      return "⚪";
  }
}

/* =========================================================
   TEST DETAIL
========================================================= */

async function showTest(chatId, testId) {
  const { data: test, error } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();

  if (error || !test) {
    await send(chatId, "❌ Test not found.", {
      reply_markup: backKeyboard("tests")
    });
    return;
  }

  const ended = test.lobby_state === "ended";

  const buttons = [];

  if (!ended) {
    buttons.push([
      {
        text: "✏️ Edit Test",
        callback_data: `${PREFIX}edittest:${test.id}`
      }
    ]);

    buttons.push([
      {
        text: "📚 Questions",
        callback_data: `${PREFIX}questions:${test.id}`
      }
    ]);
  }

  if (test.status === "draft" && !ended) {
    buttons.push([
      {
        text: "🚀 Publish Test",
        callback_data: `${PREFIX}publish:${test.id}`
      }
    ]);
  }

  if (test.status === "published" && !ended) {
    buttons.push([
      {
        text: "🛑 End Test",
        callback_data: `${PREFIX}end:${test.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}tests`
    }
  ]);

  const start = test.starts_at
    ? new Date(test.starts_at).toLocaleString("en-IN")
    : "Not set";

  const end = test.ends_at
    ? new Date(test.ends_at).toLocaleString("en-IN")
    : "Not set";

  await send(
    chatId,
    `📝 <b>${escapeHtml(test.title || "Untitled Test")}</b>

<b>Code:</b> <code>${escapeHtml(test.test_code || "N/A")}</code>
<b>Status:</b> ${escapeHtml(test.status || "N/A")}
<b>Lobby:</b> ${escapeHtml(test.lobby_state || "N/A")}
<b>Start:</b> ${escapeHtml(start)}
<b>End:</b> ${escapeHtml(end)}
<b>Duration:</b> ${test.duration_minutes || 0} minutes
<b>Total Questions:</b> ${test.total_questions || 0}
<b>Total Marks:</b> ${test.total_marks || 0}
<b>Countdown:</b> ${test.instruction_countdown_seconds || 300} seconds

${ended ? "🔴 <b>This test has ended.</b>" : ""}`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================================================
   CREATE TEST
========================================================= */

async function startCreateTest(chatId) {
  setSession(chatId, {
    state: "create_title",
    draftTest: {}
  });

  await send(
    chatId,
    "➕ <b>Create Test</b>\n\nEnter the test title:"
  );
}

async function createTestStep(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || !session.state?.startsWith("create_")) {
    return false;
  }

  const value = msg.text?.trim();

  if (!value) {
    await send(chatId, "❌ Please enter a valid value.");
    return true;
  }

  if (session.state === "create_title") {
    session.draftTest.title = value;
    session.state = "create_date";

    await send(
      chatId,
      "📅 Enter the test date.\n\nFormat: <code>YYYY-MM-DD</code>"
    );

    return true;
  }

  if (session.state === "create_date") {
    if (!isValidDate(value)) {
      await send(
        chatId,
        "❌ Invalid date.\n\nUse format: <code>YYYY-MM-DD</code>"
      );
      return true;
    }

    session.draftTest.date = value;
    session.state = "create_start_time";

    await send(
      chatId,
      "🕐 Enter the start time.\n\nFormat: <code>HH:MM</code> (24-hour)"
    );

    return true;
  }

  if (session.state === "create_start_time") {
    if (!isValidTime(value)) {
      await send(
        chatId,
        "❌ Invalid time.\n\nUse format: <code>HH:MM</code>"
      );
      return true;
    }

    session.draftTest.startTime = value;
    session.state = "create_end_time";

    await send(
      chatId,
      "🕐 Enter the end time.\n\nFormat: <code>HH:MM</code> (24-hour)"
    );

    return true;
  }

  if (session.state === "create_end_time") {
    if (!isValidTime(value)) {
      await send(
        chatId,
        "❌ Invalid time.\n\nUse format: <code>HH:MM</code>"
      );
      return true;
    }

    session.draftTest.endTime = value;
    session.state = "create_duration";

    await send(
      chatId,
      "⏱️ Enter test duration in minutes.\n\nExample: <code>180</code>"
    );

    return true;
  }

  if (session.state === "create_duration") {
    const duration = Number(value);

    if (!Number.isInteger(duration) || duration <= 0) {
      await send(
        chatId,
        "❌ Duration must be a positive whole number."
      );
      return true;
    }

    session.draftTest.duration = duration;
    session.state = "create_countdown";

    await send(
      chatId,
      "⏳ Enter instruction countdown in seconds.\n\nDefault: <code>300</code>"
    );

    return true;
  }

  if (session.state === "create_countdown") {
    const countdown = Number(value);

    if (!Number.isInteger(countdown) || countdown < 0) {
      await send(
        chatId,
        "❌ Countdown must be 0 or a positive whole number."
      );
      return true;
    }

    session.draftTest.countdown = countdown;

    await finishCreateTest(chatId);

    return true;
  }

  return false;
}

async function finishCreateTest(chatId) {
  const session = getSession(chatId);

  if (!session?.draftTest) {
    await send(chatId, "❌ Test creation session expired.");
    return;
  }

  const draft = session.draftTest;

  try {
    const ownerId = await getApplicationOwnerId();

    const startsAt = new Date(
      `${draft.date}T${draft.startTime}:00+05:30`
    ).toISOString();

    const endsAt = new Date(
      `${draft.date}T${draft.endTime}:00+05:30`
    ).toISOString();

    if (new Date(endsAt) <= new Date(startsAt)) {
      await send(
        chatId,
        "❌ End time must be later than start time.\n\nCreation cancelled. Use Create Test again."
      );

      clearSession(chatId);
      return;
    }

    const testCode = generateTestCode();

    const payload = {
      owner_id: ownerId,
      title: draft.title,
      test_code: testCode,
      status: "draft",
      lobby_state: "waiting",
      starts_at: startsAt,
      ends_at: endsAt,
      duration_minutes: draft.duration,
      total_questions: 0,
      total_marks: 0,
      instruction_countdown_seconds: draft.countdown,
      chat_enabled: false
    };

    const { data, error } = await supabase
      .from("tests")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      console.error("Create test error:", error);

      await send(
        chatId,
        `❌ <b>Could not create test.</b>\n\n<code>${escapeHtml(
          error.message
        )}</code>`
      );

      clearSession(chatId);
      return;
    }

    clearSession(chatId);

    await send(
      chatId,
      `✅ <b>Test created successfully!</b>

<b>Title:</b> ${escapeHtml(data.title)}
<b>Test Code:</b> <code>${escapeHtml(data.test_code)}</code>
<b>Status:</b> Draft

You can now add questions and publish the test.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📚 Add Questions",
                callback_data: `${PREFIX}questions:${data.id}`
              }
            ],
            [
              {
                text: "📝 Open Test",
                callback_data: `${PREFIX}test:${data.id}`
              }
            ],
            [
              {
                text: "⬅️ Tests",
                callback_data: `${PREFIX}tests`
              }
            ]
          ]
        }
      }
    );
  } catch (error) {
    console.error("finishCreateTest error:", error);

    clearSession(chatId);

    await send(
      chatId,
      `❌ <b>Test creation failed.</b>\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
  }
}

/* =========================================================
   PUBLISH TEST
========================================================= */

async function publishTest(chatId, testId) {
  const { data: test, error: fetchError } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();

  if (fetchError || !test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(
      chatId,
      "⚠️ Only draft tests can be published."
    );
    return;
  }

  const { count, error: questionError } = await supabase
    .from("questions")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("test_id", testId);

  if (questionError) {
    await send(
      chatId,
      `❌ Could not verify questions.\n\n<code>${escapeHtml(
        questionError.message
      )}</code>`
    );
    return;
  }

  if (!count || count <= 0) {
    await send(
      chatId,
      "⚠️ You cannot publish a test without questions."
    );
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "published",
      lobby_state: "waiting",
      total_questions: count,
      updated_at: new Date().toISOString()
    })
    .eq("id", testId);

  if (error) {
    await send(
      chatId,
      `❌ Publish failed.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  await send(
    chatId,
    `🚀 <b>Test Published!</b>\n\nPlayers can now join using the test code.`
  );

  await showTest(chatId, testId);
}

/* =========================================================
   END TEST
========================================================= */

async function endTest(chatId, testId) {
  const { data: test, error: fetchError } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();

  if (fetchError || !test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "published",
      lobby_state: "ended",
      updated_at: new Date().toISOString()
    })
    .eq("id", testId);

  if (error) {
    await send(
      chatId,
      `❌ Could not end test.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  await send(
    chatId,
    "🛑 <b>Test ended successfully.</b>"
  );

  await showTest(chatId, testId);
}
/* =========================================================
   QUESTIONS
========================================================= */

async function showQuestions(chatId, testId) {
  const { data: test, error: testError } = await supabase
    .from("tests")
    .select("id,title,total_questions,total_marks,status,lobby_state")
    .eq("id", testId)
    .maybeSingle();

  if (testError || !test) {
    await send(chatId, "❌ Test not found.", {
      reply_markup: backKeyboard("tests")
    });
    return;
  }

  const { data: questions, error } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", testId)
    .order("position", { ascending: true });

  if (error) {
    await send(
      chatId,
      `❌ Could not load questions.\n\n<code>${escapeHtml(
        error.message
      )}</code>`,
      {
        reply_markup: backKeyboard(`test:${testId}`)
      }
    );
    return;
  }

  const buttons = [];

  if (test.lobby_state !== "ended") {
    buttons.push([
      {
        text: "➕ Add Question",
        callback_data: `${PREFIX}addquestion:${testId}`
      }
    ]);
  }

  if (questions?.length) {
    for (const question of questions) {
      const title = question.question_text
        ? question.question_text.slice(0, 35)
        : "Untitled Question";

      buttons.push([
        {
          text: `Q${question.position || "?"} — ${title}`,
          callback_data: `${PREFIX}question:${question.id}`
        }
      ]);
    }
  }

  buttons.push([
    {
      text: "⬅️ Back to Test",
      callback_data: `${PREFIX}test:${testId}`
    }
  ]);

  await send(
    chatId,
    `📚 <b>Question Builder</b>

<b>Test:</b> ${escapeHtml(test.title)}

<b>Questions:</b> ${questions?.length || 0}
<b>Total Marks:</b> ${test.total_marks || 0}
<b>Status:</b> ${escapeHtml(test.status || "draft")}

Choose a question to edit or add a new one.`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   ADD QUESTION
========================================================= */

async function startAddQuestion(chatId, testId) {
  const { data: test, error } = await supabase
    .from("tests")
    .select("id,title,lobby_state")
    .eq("id", testId)
    .maybeSingle();

  if (error || !test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.lobby_state === "ended") {
    await send(
      chatId,
      "⛔ Questions cannot be changed after the test has ended."
    );
    return;
  }

  const { data: existingQuestions, error: countError } =
    await supabase
      .from("questions")
      .select("id,position")
      .eq("test_id", testId)
      .order("position", { ascending: false })
      .limit(1);

  if (countError) {
    await send(
      chatId,
      `❌ Could not determine question position.\n\n<code>${escapeHtml(
        countError.message
      )}</code>`
    );
    return;
  }

  const nextPosition =
    existingQuestions?.length &&
    Number.isInteger(existingQuestions[0].position)
      ? existingQuestions[0].position + 1
      : 1;

  setSession(chatId, {
    state: "question_text",
    questionDraft: {
      testId,
      position: nextPosition
    }
  });

  await send(
    chatId,
    `➕ <b>Add Question</b>

<b>Question ${nextPosition}</b>

Enter the question text:`
  );
}

/* =========================================================
   QUESTION INPUT
========================================================= */

async function processQuestionStep(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (
    !session ||
    !session.state ||
    !session.state.startsWith("question_")
  ) {
    return false;
  }

  const value = msg.text?.trim();

  if (!value) {
    await send(chatId, "❌ Please enter a valid value.");
    return true;
  }

  const draft = session.questionDraft;

  if (!draft) {
    clearSession(chatId);

    await send(
      chatId,
      "❌ Question session expired. Please start again."
    );

    return true;
  }

  if (session.state === "question_text") {
    draft.questionText = value;
    session.state = "question_type";

    await send(
      chatId,
      "📝 Select the question type:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔘 Single Correct",
                callback_data: `${PREFIX}qtype:single`
              }
            ],
            [
              {
                text: "☑️ Multiple Correct",
                callback_data: `${PREFIX}qtype:multiple`
              }
            ],
            [
              {
                text: "🔢 Numerical",
                callback_data: `${PREFIX}qtype:numerical`
              }
            ]
          ]
        }
      }
    );

    return true;
  }

  if (session.state === "question_marks") {
    const marks = Number(value);

    if (!Number.isFinite(marks) || marks <= 0) {
      await send(
        chatId,
        "❌ Marks must be greater than 0."
      );
      return true;
    }

    draft.marks = marks;

    await saveQuestionFromDraft(chatId);

    return true;
  }

  if (session.state === "question_option_a") {
    draft.optionA = value;
    session.state = "question_option_b";

    await send(chatId, "Enter option B:");

    return true;
  }

  if (session.state === "question_option_b") {
    draft.optionB = value;
    session.state = "question_option_c";

    await send(chatId, "Enter option C:");

    return true;
  }

  if (session.state === "question_option_c") {
    draft.optionC = value;
    session.state = "question_option_d";

    await send(chatId, "Enter option D:");

    return true;
  }

  if (session.state === "question_option_d") {
    draft.optionD = value;
    session.state = "question_marks";

    await send(
      chatId,
      "💯 Enter marks for this question:"
    );

    return true;
  }

  if (session.state === "question_numerical_answer") {
    draft.numericalAnswer = value;
    session.state = "question_marks";

    await send(
      chatId,
      "💯 Enter marks for this question:"
    );

    return true;
  }

  return false;
}

/* =========================================================
   QUESTION TYPE CALLBACK
========================================================= */

async function selectQuestionType(chatId, type) {
  const session = getSession(chatId);

  if (
    !session ||
    session.state !== "question_type" ||
    !session.questionDraft
  ) {
    await send(
      chatId,
      "❌ Question session expired. Please start again."
    );
    return;
  }

  const allowedTypes = [
    "single",
    "multiple",
    "numerical"
  ];

  if (!allowedTypes.includes(type)) {
    await send(chatId, "❌ Invalid question type.");
    return;
  }

  session.questionDraft.questionType = type;

  if (type === "numerical") {
    session.state = "question_numerical_answer";

    await send(
      chatId,
      "🔢 Enter the numerical answer:"
    );

    return;
  }

  session.state = "question_option_a";

  await send(
    chatId,
    "Enter option A:"
  );
}

/* =========================================================
   SAVE QUESTION
========================================================= */

async function saveQuestionFromDraft(chatId) {
  const session = getSession(chatId);
  const draft = session?.questionDraft;

  if (!draft) {
    clearSession(chatId);

    await send(
      chatId,
      "❌ Question session expired."
    );

    return;
  }

  const payload = {
    test_id: draft.testId,
    position: draft.position,
    question_text: draft.questionText,
    question_type: draft.questionType,
    marks: draft.marks
  };

  /*
   * Correct answers are intentionally NOT saved here.
   * Answer-key configuration belongs to the later
   * answer-key/scoring stage.
   */

  if (
    draft.questionType === "single" ||
    draft.questionType === "multiple"
  ) {
    payload.options = [
      {
        label: "A",
        text: draft.optionA
      },
      {
        label: "B",
        text: draft.optionB
      },
      {
        label: "C",
        text: draft.optionC
      },
      {
        label: "D",
        text: draft.optionD
      }
    ];
  }

  if (draft.questionType === "numerical") {
    payload.options = [];
  }

  const { data: question, error } = await supabase
    .from("questions")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("Question insert error:", error);

    await send(
      chatId,
      `❌ <b>Could not save question.</b>

<code>${escapeHtml(error.message)}</code>`
    );

    return;
  }

  const { count: questionCount } = await supabase
    .from("questions")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("test_id", draft.testId);

  const { data: allQuestions } = await supabase
    .from("questions")
    .select("marks")
    .eq("test_id", draft.testId);

  const totalMarks = (allQuestions || []).reduce(
    (sum, item) => sum + Number(item.marks || 0),
    0
  );

  await supabase
    .from("tests")
    .update({
      total_questions: questionCount || 0,
      total_marks: totalMarks,
      updated_at: new Date().toISOString()
    })
    .eq("id", draft.testId);

  const testId = draft.testId;

  clearSession(chatId);

  await send(
    chatId,
    `✅ <b>Question added successfully!</b>

<b>Question:</b> ${question.position || draft.position}
<b>Type:</b> ${escapeHtml(draft.questionType)}
<b>Marks:</b> ${draft.marks}

Correct answer has not been set yet.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Another",
              callback_data: `${PREFIX}addquestion:${testId}`
            }
          ],
          [
            {
              text: "📚 Questions",
              callback_data: `${PREFIX}questions:${testId}`
            }
          ],
          [
            {
              text: "📝 Test",
              callback_data: `${PREFIX}test:${testId}`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   QUESTION DETAIL
========================================================= */

async function showQuestion(chatId, questionId) {
  const { data: question, error } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (error || !question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const options = Array.isArray(question.options)
    ? question.options
    : [];

  let optionText = "";

  for (const option of options) {
    optionText += `\n<b>${escapeHtml(
      option.label || ""
    )}.</b> ${escapeHtml(option.text || "")}`;
  }

  const buttons = [
    [
      {
        text: "✏️ Edit",
        callback_data: `${PREFIX}editquestion:${question.id}`
      }
    ],
    [
      {
        text: "🗑️ Delete",
        callback_data: `${PREFIX}deletequestion:${question.id}`
      }
    ],
    [
      {
        text: "📚 Back to Questions",
        callback_data: `${PREFIX}questions:${question.test_id}`
      }
    ]
  ];

  await send(
    chatId,
    `❓ <b>Question ${question.position || ""}</b>

${escapeHtml(question.question_text || "")}

<b>Type:</b> ${escapeHtml(
      question.question_type || "N/A"
    )}
<b>Marks:</b> ${question.marks || 0}
${optionText}`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   DELETE QUESTION
========================================================= */

async function confirmDeleteQuestion(chatId, questionId) {
  const { data: question } = await supabase
    .from("questions")
    .select("id,test_id,position,question_text")
    .eq("id", questionId)
    .maybeSingle();

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  await send(
    chatId,
    `⚠️ <b>Delete Question?</b>

Question ${question.position || ""}
${escapeHtml(question.question_text || "")}

This action cannot be undone.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑️ Yes, Delete",
              callback_data: `${PREFIX}confirmdelete:${question.id}`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: `${PREFIX}question:${question.id}`
            }
          ]
        ]
      }
    }
  );
}

async function deleteQuestion(chatId, questionId) {
  const { data: question, error: findError } = await supabase
    .from("questions")
    .select("id,test_id")
    .eq("id", questionId)
    .maybeSingle();

  if (findError || !question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const testId = question.test_id;

  const { error } = await supabase
    .from("questions")
    .delete()
    .eq("id", questionId);

  if (error) {
    await send(
      chatId,
      `❌ Delete failed.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  const { data: remaining } = await supabase
    .from("questions")
    .select("id,position,marks")
    .eq("test_id", testId)
    .order("position", { ascending: true });

  if (remaining?.length) {
    for (let i = 0; i < remaining.length; i++) {
      await supabase
        .from("questions")
        .update({
          position: i + 1
        })
        .eq("id", remaining[i].id);
    }
  }

  const totalQuestions = remaining?.length || 0;

  const totalMarks = (remaining || []).reduce(
    (sum, item) => sum + Number(item.marks || 0),
    0
  );

  await supabase
    .from("tests")
    .update({
      total_questions: totalQuestions,
      total_marks: totalMarks,
      updated_at: new Date().toISOString()
    })
    .eq("id", testId);

  await send(
    chatId,
    "✅ Question deleted successfully.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📚 Questions",
              callback_data: `${PREFIX}questions:${testId}`
            }
          ],
          [
            {
              text: "📝 Test",
              callback_data: `${PREFIX}test:${testId}`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   SUBJECTS
========================================================= */

async function showSubjects(chatId) {
  const { data: subjects, error } = await supabase
    .from("subjects")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    await send(
      chatId,
      `❌ Could not load subjects.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  const buttons = [];

  for (const subject of subjects || []) {
    buttons.push([
      {
        text: `📘 ${subject.name}`,
        callback_data: `${PREFIX}subject:${subject.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "➕ Add Subject",
      callback_data: `${PREFIX}addsubject`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}panel`
    }
  ]);

  let text = "📚 <b>Subjects</b>\n\n";

  if (!subjects?.length) {
    text += "No subjects found.\n";
  } else {
    text += `Total subjects: <b>${subjects.length}</b>\n`;
  }

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

/* =========================================================
   ADD SUBJECT
========================================================= */

async function startAddSubject(chatId) {
  setSession(chatId, {
    state: "subject_name"
  });

  await send(
    chatId,
    "➕ <b>Add Subject</b>\n\nEnter subject name:"
  );
}

async function processSubjectStep(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "subject_name") {
    return false;
  }

  const name = msg.text?.trim();

  if (!name) {
    await send(
      chatId,
      "❌ Subject name cannot be empty."
    );
    return true;
  }

  const { data: existing } = await supabase
    .from("subjects")
    .select("id,name")
    .ilike("name", name)
    .maybeSingle();

  if (existing) {
    await send(
      chatId,
      "⚠️ A subject with this name already exists."
    );
    return true;
  }

  const { data, error } = await supabase
    .from("subjects")
    .insert({
      name
    })
    .select("*")
    .single();

  if (error) {
    await send(
      chatId,
      `❌ Could not create subject.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return true;
  }

  clearSession(chatId);

  await send(
    chatId,
    `✅ <b>Subject created!</b>\n\n📘 ${escapeHtml(
      data.name
    )}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📚 Subjects",
              callback_data: `${PREFIX}subjects`
            }
          ],
          [
            {
              text: "⬅️ Panel",
              callback_data: `${PREFIX}panel`
            }
          ]
        ]
      }
    }
  );

  return true;
}

/* =========================================================
   SUBJECT DETAIL
========================================================= */

async function showSubject(chatId, subjectId) {
  const { data: subject, error } = await supabase
    .from("subjects")
    .select("*")
    .eq("id", subjectId)
    .maybeSingle();

  if (error || !subject) {
    await send(chatId, "❌ Subject not found.");
    return;
  }

  await send(
    chatId,
    `📘 <b>${escapeHtml(subject.name)}</b>`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑️ Delete",
              callback_data: `${PREFIX}deletesubject:${subject.id}`
            }
          ],
          [
            {
              text: "⬅️ Subjects",
              callback_data: `${PREFIX}subjects`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   DELETE SUBJECT
========================================================= */

async function deleteSubject(chatId, subjectId) {
  const { data: subject, error: findError } = await supabase
    .from("subjects")
    .select("id,name")
    .eq("id", subjectId)
    .maybeSingle();

  if (findError || !subject) {
    await send(chatId, "❌ Subject not found.");
    return;
  }

  const { error } = await supabase
    .from("subjects")
    .delete()
    .eq("id", subjectId);

  if (error) {
    await send(
      chatId,
      `❌ Could not delete subject.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  await send(
    chatId,
    `✅ Subject <b>${escapeHtml(
      subject.name
    )}</b> deleted.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📚 Subjects",
              callback_data: `${PREFIX}subjects`
            }
          ]
        ]
      }
    }
  );
}
/* =========================================================
   ADMIN MANAGEMENT
========================================================= */

async function showAdminList(chatId) {
  const { data: admins, error } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role,is_active,created_at")
    .order("created_at", { ascending: true });

  if (error) {
    await send(
      chatId,
      `❌ Could not load admins.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  const buttons = [];

  for (const admin of admins || []) {
    const role = admin.role === "owner" ? "👑 Owner" : "🛡️ Admin";
    const status = admin.is_active ? "🟢" : "🔴";

    buttons.push([
      {
        text: `${status} ${role} — ${admin.telegram_user_id}`,
        callback_data: `${PREFIX}oneadmin:${admin.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "➕ Add Admin",
      callback_data: `${PREFIX}addadmin`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}panel`
    }
  ]);

  await send(
    chatId,
    `👥 <b>Admin Management</b>

Total accounts: <b>${admins?.length || 0}</b>

👑 Owner = full access
🛡️ Admin = normal admin access`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function showManageAdminList(chatId) {
  const { data: admins, error } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role,is_active")
    .neq("role", "owner")
    .order("telegram_user_id", { ascending: true });

  if (error) {
    await send(
      chatId,
      `❌ Could not load admins.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  const buttons = [];

  for (const admin of admins || []) {
    buttons.push([
      {
        text: `${admin.is_active ? "🟢" : "🔴"} ${admin.telegram_user_id}`,
        callback_data: `${PREFIX}oneadmin:${admin.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "➕ Add Admin",
      callback_data: `${PREFIX}addadmin`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}admins`
    }
  ]);

  await send(
    chatId,
    "🛡️ <b>Manage Admins</b>\n\nSelect an admin:",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function showOneAdmin(chatId, adminId) {
  const { data: admin, error } = await supabase
    .from("telegram_admins")
    .select("*")
    .eq("id", adminId)
    .maybeSingle();

  if (error || !admin) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  const role =
    admin.role === "owner"
      ? "👑 Owner"
      : "🛡️ Admin";

  const status =
    admin.is_active
      ? "🟢 Active"
      : "🔴 Disabled";

  const buttons = [];

  if (admin.role !== "owner") {
    buttons.push([
      {
        text: "🔑 Change Password",
        callback_data: `${PREFIX}changepassadmin:${admin.id}`
      }
    ]);

    buttons.push([
      {
        text: admin.is_active
          ? "🔴 Disable Admin"
          : "🟢 Enable Admin",
        callback_data: `${PREFIX}toggleadmin:${admin.id}`
      }
    ]);

    buttons.push([
      {
        text: "🗑️ Remove Admin",
        callback_data: `${PREFIX}removeadmin:${admin.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}manageadmins`
    }
  ]);

  await send(
    chatId,
    `👤 <b>Admin Details</b>

<b>Telegram ID:</b> <code>${admin.telegram_user_id}</code>
<b>Role:</b> ${role}
<b>Status:</b> ${status}`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   ADD ADMIN
========================================================= */

async function startAddAdmin(chatId) {
  setSession(chatId, {
    state: "add_admin_id"
  });

  await send(
    chatId,
    "➕ <b>Add Admin</b>\n\nEnter the Telegram numeric user ID:"
  );
}

async function processAddAdminStep(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "add_admin_id") {
    return false;
  }

  const telegramId = Number(msg.text?.trim());

  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    await send(
      chatId,
      "❌ Invalid Telegram user ID."
    );
    return true;
  }

  const { data: existing, error: lookupError } =
    await supabase
      .from("telegram_admins")
      .select("id,telegram_user_id,role,is_active")
      .eq("telegram_user_id", telegramId)
      .maybeSingle();

  if (lookupError) {
    await send(
      chatId,
      `❌ Could not check existing admin.\n\n<code>${escapeHtml(
        lookupError.message
      )}</code>`
    );
    return true;
  }

  if (existing) {
    await send(
      chatId,
      existing.is_active
        ? "⚠️ This Telegram account is already an active admin."
        : "⚠️ This account already exists but is disabled."
    );

    clearSession(chatId);
    return true;
  }

  session.pendingAdminId = telegramId;
  session.state = "add_admin_password";

  await send(
    chatId,
    "🔐 Enter a password for the new admin:"
  );

  return true;
}

async function finishAddAdmin(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "add_admin_password") {
    return false;
  }

  const password = msg.text?.trim();

  if (!password || password.length < 6) {
    await send(
      chatId,
      "❌ Password must be at least 6 characters."
    );
    return true;
  }

  const telegramId = session.pendingAdminId;

  const { error } = await supabase
    .from("telegram_admins")
    .insert({
      telegram_user_id: telegramId,
      role: "admin",
      password_hash: hashPassword(password),
      is_active: true
    });

  if (error) {
    await send(
      chatId,
      `❌ Could not add admin.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );

    clearSession(chatId);
    return true;
  }

  clearSession(chatId);

  await send(
    chatId,
    `✅ <b>Admin added successfully.</b>

Telegram ID:
<code>${telegramId}</code>

The admin can now authenticate using the password you configured.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "👥 Admins",
              callback_data: `${PREFIX}admins`
            }
          ]
        ]
      }
    }
  );

  return true;
}

/* =========================================================
   CHANGE ADMIN PASSWORD
========================================================= */

async function startAdminPasswordChange(chatId, adminId) {
  const { data: admin, error } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role")
    .eq("id", adminId)
    .maybeSingle();

  if (error || !admin) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  if (admin.role === "owner") {
    await send(
      chatId,
      "⛔ The owner password cannot be changed from this menu."
    );
    return;
  }

  setSession(chatId, {
    state: "admin_change_password",
    changingAdminId: admin.id
  });

  await send(
    chatId,
    `🔑 <b>Change Admin Password</b>

Telegram ID:
<code>${admin.telegram_user_id}</code>

Enter the new password:`
  );
}

async function processAdminPasswordChange(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (
    !session ||
    session.state !== "admin_change_password"
  ) {
    return false;
  }

  const password = msg.text?.trim();

  if (!password || password.length < 6) {
    await send(
      chatId,
      "❌ Password must be at least 6 characters."
    );
    return true;
  }

  const { data: admin, error: findError } =
    await supabase
      .from("telegram_admins")
      .select("id,role")
      .eq("id", session.changingAdminId)
      .maybeSingle();

  if (findError || !admin) {
    clearSession(chatId);
    await send(chatId, "❌ Admin not found.");
    return true;
  }

  if (admin.role === "owner") {
    clearSession(chatId);
    await send(
      chatId,
      "⛔ Owner password cannot be changed here."
    );
    return true;
  }

  const { error } = await supabase
    .from("telegram_admins")
    .update({
      password_hash: hashPassword(password),
      updated_at: new Date().toISOString()
    })
    .eq("id", admin.id);

  if (error) {
    await send(
      chatId,
      `❌ Password change failed.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return true;
  }

  clearSession(chatId);

  await send(
    chatId,
    "✅ <b>Password changed successfully.</b>",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "👥 Admins",
              callback_data: `${PREFIX}admins`
            }
          ]
        ]
      }
    }
  );

  return true;
}

/* =========================================================
   TOGGLE ADMIN
========================================================= */

async function toggleAdmin(chatId, adminId) {
  const { data: admin, error } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role,is_active")
    .eq("id", adminId)
    .maybeSingle();

  if (error || !admin) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  if (admin.role === "owner") {
    await send(
      chatId,
      "⛔ Owner cannot be disabled."
    );
    return;
  }

  const newStatus = !admin.is_active;

  const { error: updateError } = await supabase
    .from("telegram_admins")
    .update({
      is_active: newStatus,
      updated_at: new Date().toISOString()
    })
    .eq("id", admin.id);

  if (updateError) {
    await send(
      chatId,
      `❌ Could not update admin.\n\n<code>${escapeHtml(
        updateError.message
      )}</code>`
    );
    return;
  }

  await send(
    chatId,
    newStatus
      ? "🟢 Admin enabled successfully."
      : "🔴 Admin disabled successfully."
  );

  await showOneAdmin(chatId, admin.id);
}

/* =========================================================
   REMOVE ADMIN
========================================================= */

async function confirmRemoveAdmin(chatId, adminId) {
  const { data: admin } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role")
    .eq("id", adminId)
    .maybeSingle();

  if (!admin) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  if (admin.role === "owner") {
    await send(
      chatId,
      "⛔ Owner cannot be removed."
    );
    return;
  }

  await send(
    chatId,
    `⚠️ <b>Remove Admin?</b>

Telegram ID:
<code>${admin.telegram_user_id}</code>

This will permanently remove the admin account.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑️ Yes, Remove",
              callback_data: `${PREFIX}confirmremove:${admin.id}`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: `${PREFIX}oneadmin:${admin.id}`
            }
          ]
        ]
      }
    }
  );
}

async function removeAdmin(chatId, adminId) {
  const { data: admin } = await supabase
    .from("telegram_admins")
    .select("id,telegram_user_id,role")
    .eq("id", adminId)
    .maybeSingle();

  if (!admin) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  if (admin.role === "owner") {
    await send(
      chatId,
      "⛔ Owner cannot be removed."
    );
    return;
  }

  const { error } = await supabase
    .from("telegram_admins")
    .delete()
    .eq("id", adminId);

  if (error) {
    await send(
      chatId,
      `❌ Could not remove admin.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
    return;
  }

  await send(
    chatId,
    "✅ Admin removed successfully.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "👥 Admins",
              callback_data: `${PREFIX}admins`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   ADMIN MENU
========================================================= */

async function showAdminsMenu(chatId, admin) {
  const buttons = [];

  if (isOwner(admin)) {
    buttons.push([
      {
        text: "➕ Add Admin",
        callback_data: `${PREFIX}addadmin`
      }
    ]);

    buttons.push([
      {
        text: "🛠️ Manage Admins",
        callback_data: `${PREFIX}manageadmins`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}panel`
    }
  ]);

  await send(
    chatId,
    isOwner(admin)
      ? "👥 <b>Admin Management</b>\n\nYou are the owner. Choose an action:"
      : "👥 <b>Admin Information</b>\n\nOnly the owner can manage admin accounts.",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   CALLBACK ROUTER
========================================================= */

bot.on("callback_query", async (query) => {
  try {
    const admin = await requireCallbackAuth(query);

    if (!admin) return;

    const chatId = query.message.chat.id;
    const data = query.data || "";

    await bot
      .answerCallbackQuery(query.id)
      .catch(() => {});

    if (!data.startsWith(PREFIX)) {
      return;
    }

    const action = data.slice(PREFIX.length);

    /* -------------------------
       GENERAL
    ------------------------- */

    if (action === "panel") {
      await showPanel(chatId);
      return;
    }

    if (action === "help") {
      await showHelp(chatId);
      return;
    }

    if (action === "logout") {
      clearSession(chatId);

      await send(
        chatId,
        "🚪 <b>Logged out successfully.</b>\n\nUse /start to login again."
      );

      return;
    }

    /* -------------------------
       TESTS
    ------------------------- */

    if (action === "tests") {
      await showTests(chatId);
      return;
    }

    if (action === "createtest") {
      await startCreateTest(chatId);
      return;
    }

    if (action.startsWith("test:")) {
      const testId = action.split(":")[1];
      await showTest(chatId, testId);
      return;
    }

    if (action.startsWith("publish:")) {
      const testId = action.split(":")[1];
      await publishTest(chatId, testId);
      return;
    }

    if (action.startsWith("end:")) {
      const testId = action.split(":")[1];

      await send(
        chatId,
        "⚠️ <b>End this test?</b>\n\nThis will mark the lobby as ended.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🛑 Yes, End Test",
                  callback_data: `${PREFIX}confirmend:${testId}`
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data: `${PREFIX}test:${testId}`
                }
              ]
            ]
          }
        }
      );

      return;
    }

    if (action.startsWith("confirmend:")) {
      const testId = action.split(":")[1];
      await endTest(chatId, testId);
      return;
    }

    /* -------------------------
       QUESTIONS
    ------------------------- */

    if (action.startsWith("questions:")) {
      const testId = action.split(":")[1];
      await showQuestions(chatId, testId);
      return;
    }

    if (action.startsWith("addquestion:")) {
      const testId = action.split(":")[1];
      await startAddQuestion(chatId, testId);
      return;
    }

    if (action.startsWith("qtype:")) {
      const type = action.split(":")[1];
      await selectQuestionType(chatId, type);
      return;
    }

    if (action.startsWith("question:")) {
      const questionId = action.split(":")[1];
      await showQuestion(chatId, questionId);
      return;
    }

    if (action.startsWith("deletequestion:")) {
      const questionId = action.split(":")[1];
      await confirmDeleteQuestion(chatId, questionId);
      return;
    }

    if (action.startsWith("confirmdelete:")) {
      const questionId = action.split(":")[1];
      await deleteQuestion(chatId, questionId);
      return;
    }

    /* -------------------------
       SUBJECTS
    ------------------------- */

    if (action === "subjects") {
      await showSubjects(chatId);
      return;
    }

    if (action === "addsubject") {
      await startAddSubject(chatId);
      return;
    }

    if (action.startsWith("subject:")) {
      const subjectId = action.split(":")[1];
      await showSubject(chatId, subjectId);
      return;
    }

    if (action.startsWith("deletesubject:")) {
      const subjectId = action.split(":")[1];

      await send(
        chatId,
        "⚠️ <b>Delete this subject?</b>",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🗑️ Yes, Delete",
                  callback_data: `${PREFIX}confirmdeletesubject:${subjectId}`
                }
              ],
              [
                {
                  text: "❌ Cancel",
                  callback_data: `${PREFIX}subject:${subjectId}`
                }
              ]
            ]
          }
        }
      );

      return;
    }

    if (action.startsWith("confirmdeletesubject:")) {
      const subjectId = action.split(":")[1];
      await deleteSubject(chatId, subjectId);
      return;
    }

    /* -------------------------
       ADMINS
    ------------------------- */

    if (action === "admins") {
      await showAdminsMenu(chatId, admin);
      return;
    }

    if (action === "manageadmins") {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      await showManageAdminList(chatId);
      return;
    }

    if (action === "addadmin") {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      await startAddAdmin(chatId);
      return;
    }

    if (action.startsWith("oneadmin:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      const adminId = action.split(":")[1];
      await showOneAdmin(chatId, adminId);
      return;
    }

    if (action.startsWith("changepassadmin:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      const adminId = action.split(":")[1];
      await startAdminPasswordChange(chatId, adminId);
      return;
    }

    if (action.startsWith("toggleadmin:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      const adminId = action.split(":")[1];
      await toggleAdmin(chatId, adminId);
      return;
    }

    if (action.startsWith("removeadmin:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      const adminId = action.split(":")[1];
      await confirmRemoveAdmin(chatId, adminId);
      return;
    }

    if (action.startsWith("confirmremove:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner access required.");
        return;
      }

      const adminId = action.split(":")[1];
      await removeAdmin(chatId, adminId);
      return;
    }

    await send(chatId, "⚠️ Unknown action.");
  } catch (error) {
    console.error("Callback error:", error);

    if (query.message?.chat?.id) {
      await send(
        query.message.chat.id,
        `❌ Something went wrong.\n\n<code>${escapeHtml(
          error.message
        )}</code>`
      );
    }
  }
});

/* =========================================================
   MESSAGE ROUTER
========================================================= */

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return;

    const text = msg.text?.trim() || "";

    if (text === "/start") {
      const admin = await getAdmin(userId);

      if (!admin) {
        clearSession(chatId);

        await send(
          chatId,
          "⛔ <b>Access Denied</b>\n\nThis Telegram account is not authorized."
        );

        return;
      }

      clearSession(chatId);
      await startLogin(chatId, userId);
      return;
    }

    if (text === "/cancel") {
      if (sessionIsAuthenticated(chatId, userId)) {
        setSession(chatId, {
          state: null,
          draftTest: null,
          questionDraft: null,
          pendingAdminId: null,
          changingAdminId: null
        });

        await send(
          chatId,
          "❌ Current operation cancelled.",
          {
            reply_markup: mainKeyboard()
          }
        );
      } else {
        clearSession(chatId);

        await send(
          chatId,
          "❌ Operation cancelled.\n\nUse /start to login."
        );
      }

      return;
    }

    const session = getSession(chatId);

    /* -------------------------
       LOGIN
    ------------------------- */

    if (
      session &&
      session.state === "password"
    ) {
      if (Number(session.authUserId) !== Number(userId)) {
        return;
      }

      await processPassword(msg);
      return;
    }

    /* -------------------------
       AUTH CHECK
    ------------------------- */

    if (!sessionIsAuthenticated(chatId, userId)) {
      await startLogin(chatId, userId);
      return;
    }

    /* -------------------------
       CREATE TEST
    ------------------------- */

    if (
      session?.state &&
      session.state.startsWith("create_")
    ) {
      await createTestStep(msg);
      return;
    }

    /* -------------------------
       QUESTION BUILDER
    ------------------------- */

    if (
      session?.state &&
      session.state.startsWith("question_")
    ) {
      await processQuestionStep(msg);
      return;
    }

    /* -------------------------
       SUBJECT
    ------------------------- */

    if (session?.state === "subject_name") {
      await processSubjectStep(msg);
      return;
    }

    /* -------------------------
       ADD ADMIN
    ------------------------- */

    if (
      session?.state === "add_admin_id" ||
      session?.state === "add_admin_password"
    ) {
      const admin = await getAdmin(userId);

      if (!admin || !isOwner(admin)) {
        clearSession(chatId);

        await send(
          chatId,
          "⛔ Owner access required."
        );

        return;
      }

      if (session.state === "add_admin_id") {
        await processAddAdminStep(msg);
      } else {
        await finishAddAdmin(msg);
      }

      return;
    }

    /* -------------------------
       CHANGE ADMIN PASSWORD
    ------------------------- */

    if (
      session?.state === "admin_change_password"
    ) {
      const admin = await getAdmin(userId);

      if (!admin || !isOwner(admin)) {
        clearSession(chatId);

        await send(
          chatId,
          "⛔ Owner access required."
        );

        return;
      }

      await processAdminPasswordChange(msg);
      return;
    }

  } catch (error) {
    console.error("Message error:", error);

    await send(
      msg.chat.id,
      `❌ Unexpected error.\n\n<code>${escapeHtml(
        error.message
      )}</code>`
    );
  }
});

/* =========================================================
   COMMANDS
========================================================= */

bot.onText(/^\/panel$/, async (msg) => {
  try {
    const admin = await requireAuth(msg);

    if (!admin) return;

    if (
      !sessionIsAuthenticated(
        msg.chat.id,
        msg.from.id
      )
    ) {
      await startLogin(
        msg.chat.id,
        msg.from.id
      );
      return;
    }

    await showPanel(msg.chat.id);
  } catch (error) {
    console.error("/panel error:", error);
  }
});

bot.onText(/^\/help$/, async (msg) => {
  try {
    const admin = await requireAuth(msg);

    if (!admin) return;

    if (
      !sessionIsAuthenticated(
        msg.chat.id,
        msg.from.id
      )
    ) {
      await startLogin(
        msg.chat.id,
        msg.from.id
      );
      return;
    }

    await showHelp(msg.chat.id);
  } catch (error) {
    console.error("/help error:", error);
  }
});

/* =========================================================
   STARTUP
========================================================= */

(async () => {
  try {
    await ensureOwnerAccount();

    console.log("====================================");
    console.log("PrepArena Admin Bot started");
    console.log("Owner Telegram ID:", OWNER_TELEGRAM_ID);
    console.log("Polling: enabled");
    console.log("====================================");
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );
  }
})();

process.on("unhandledRejection", (error) => {
  console.error(
    "Unhandled promise rejection:",
    error
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "Uncaught exception:",
    error
  );
});
