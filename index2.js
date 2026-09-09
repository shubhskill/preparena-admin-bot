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
    throw new Error(`Could not find application owner: ${error.message}`);
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
        { text: "📝 Tests", callback_data: `${PREFIX}tests` },
        { text: "📚 Subjects", callback_data: `${PREFIX}subjects` }
      ],
      [
        { text: "👥 Admins", callback_data: `${PREFIX}admins` },
        { text: "❓ Help", callback_data: `${PREFIX}help` }
      ],
      [
        { text: "🚪 Logout", callback_data: `${PREFIX}logout` }
      ]
    ]
  };
}

function backKeyboard(callback = "panel") {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Back", callback_data: `${PREFIX}${callback}` }]
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

  // Always synchronize the owner password with the Railway OWNER_PASSWORD
  // environment variable. This fixes the case where the database contains
  // an older password hash from a previous deployment/password.
  const { error: updateError } = await supabase
    .from("telegram_admins")
    .update({
      role: "owner",
      is_active: true,
      password_hash: hashPassword(OWNER_PASSWORD),
      updated_at: new Date().toISOString()
    })
    .eq("telegram_user_id", OWNER_TELEGRAM_ID);

  if (updateError) {
    console.error("Owner update error:", updateError);
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
    await bot.answerCallbackQuery(query.id, {
      text: "Invalid request.",
      show_alert: true
    }).catch(() => {});
    return null;
  }

  if (!sessionIsAuthenticated(chatId, userId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "Please authenticate first.",
      show_alert: true
    }).catch(() => {});
    await startLogin(chatId, userId);
    return null;
  }

  const admin = await getAdmin(userId);

  if (!admin) {
    clearSession(chatId);
    await bot.answerCallbackQuery(query.id, {
      text: "Access denied.",
      show_alert: true
    }).catch(() => {});
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

  if (!session || session.state !== "password") return false;

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
• Create tests
• Edit draft tests
• Manage subjects
• Add questions
• Edit questions
• Delete questions
• Publish / end tests

<b>Question Types</b>
• MCQ
• Multiple Correct
• Numerical

<b>Important</b>
Correct answers are NOT entered while creating questions.
They will be added later through the Answer Key system.

Use /cancel anytime to cancel the current operation.`,
    {
      reply_markup: backKeyboard()
    }
  );
}

/* =========================================================
   TESTS
========================================================= */

async function showTests(chatId) {
  const { data, error } = await supabase
    .from("tests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load tests.");
    return;
  }

  const buttons = [];

  for (const test of data || []) {
    buttons.push([
      {
        text: `${statusEmoji(test.status)} ${test.title}`,
        callback_data: `${PREFIX}test:${test.id}`
      }
    ]);
  }

  buttons.push([
    { text: "➕ Create Test", callback_data: `${PREFIX}create` }
  ]);

  buttons.push([
    { text: "⬅️ Back", callback_data: `${PREFIX}panel` }
  ]);

  await send(
    chatId,
    `📝 <b>Tests</b>\n\n${
      data?.length
        ? "Select a test:"
        : "No tests created yet."
    }`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

function statusEmoji(status) {
  if (status === "published") return "🟢";
  if (status === "ended") return "🔴";
  return "🟡";
}

async function getTest(testId) {
  const { data, error } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return null;
  }

  return data;
}

async function showTestDetail(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  const { data: testSubjects } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq("test_id", testId);

  let subjectText = "None";

  if (testSubjects?.length) {
    const ids = testSubjects.map(x => x.subject_id);

    const { data: subjects } = await supabase
      .from("subjects")
      .select("name")
      .in("id", ids);

    subjectText =
      subjects?.map(s => s.name).join(", ") || "None";
  }

  await send(
    chatId,
    `📝 <b>${escapeHtml(test.title)}</b>

<b>Status:</b> ${test.lobby_state === "ended" ? "ended" : test.status}
<b>Description:</b> ${escapeHtml(test.description || "Not set")}
<b>Date:</b> ${test.test_date || "Not set"}
<b>Time:</b> ${test.test_time || "Not set"}
<b>Duration:</b> ${test.duration_minutes} min
<b>Marks/Question:</b> ${test.marks_per_question}
<b>Negative:</b> ${
      test.negative_marking_enabled
        ? `Yes (-${test.negative_marking_value})`
        : "No"
    }
<b>Questions:</b> ${test.total_questions}
<b>Total Marks:</b> ${test.total_marks}
<b>Subjects:</b> ${escapeHtml(subjectText)}
<b>Instructions:</b> ${escapeHtml(test.instructions || "Not set")}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✏️ Edit Test",
              callback_data: `${PREFIX}edit:${testId}`
            }
          ],
          [
            {
              text: "❓ Questions",
              callback_data: `${PREFIX}questions:${testId}`
            }
          ],
          [
            {
              text: "📚 Subjects",
              callback_data: `${PREFIX}tsub:${testId}`
            }
          ],
          ...(test.status === "draft"
            ? [
                [
                  {
                    text: "🚀 Publish Test",
                    callback_data: `${PREFIX}publish:${testId}`
                  }
                ]
              ]
            : []),
          ...(test.status === "published" && test.lobby_state !== "ended"
            ? [
                [
                  {
                    text: "🔴 End Test",
                    callback_data: `${PREFIX}end:${testId}`
                  }
                ]
              ]
            : []),
          [
            {
              text: "⬅️ Back",
              callback_data: `${PREFIX}tests`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   ESCAPE
========================================================= */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    "➕ <b>Create Test</b>\n\nEnter test title:"
  );
}

async function processCreateTest(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || !session.state?.startsWith("create_")) {
    return false;
  }

  const text = msg.text.trim();

  if (session.state === "create_title") {
    if (!text) {
      await send(chatId, "❌ Title cannot be empty.");
      return true;
    }

    setSession(chatId, {
      state: "create_description",
      draftTest: {
        ...session.draftTest,
        title: text
      }
    });

    await send(chatId, "Enter description (or type <code>skip</code>):");
    return true;
  }

  if (session.state === "create_description") {
    setSession(chatId, {
      state: "create_date",
      draftTest: {
        ...session.draftTest,
        description: text.toLowerCase() === "skip" ? null : text
      }
    });

    await send(chatId, "Enter test date (YYYY-MM-DD) or <code>skip</code>:");
    return true;
  }

  if (session.state === "create_date") {
    let date = null;

    if (text.toLowerCase() !== "skip") {
      if (!isValidDate(text)) {
        await send(chatId, "❌ Use a valid date in YYYY-MM-DD format.");
        return true;
      }

      date = text;
    }

    setSession(chatId, {
      state: "create_time",
      draftTest: {
        ...session.draftTest,
        test_date: date
      }
    });

    await send(chatId, "Enter test time (HH:MM) or <code>skip</code>:");
    return true;
  }

  if (session.state === "create_time") {
    let time = null;

    if (text.toLowerCase() !== "skip") {
      if (!isValidTime(text)) {
        await send(chatId, "❌ Use a valid time in HH:MM format.");
        return true;
      }

      time = text;
    }

    setSession(chatId, {
      state: "create_duration",
      draftTest: {
        ...session.draftTest,
        test_time: time
      }
    });

    await send(chatId, "Enter duration in minutes:");
    return true;
  }

  if (session.state === "create_duration") {
    const duration = Number(text);

    if (!Number.isInteger(duration) || duration <= 0) {
      await send(chatId, "❌ Duration must be a positive number.");
      return true;
    }

    setSession(chatId, {
      state: "create_marks",
      draftTest: {
        ...session.draftTest,
        duration_minutes: duration
      }
    });

    await send(chatId, "Enter marks per question:");
    return true;
  }

  if (session.state === "create_marks") {
    const marks = Number(text);

    if (!Number.isFinite(marks) || marks <= 0) {
      await send(chatId, "❌ Marks must be greater than 0.");
      return true;
    }

    setSession(chatId, {
      state: "create_negative",
      draftTest: {
        ...session.draftTest,
        marks_per_question: marks
      }
    });

    await send(
      chatId,
      "Negative marking?\n\nReply <code>yes</code> or <code>no</code>:"
    );

    return true;
  }

  if (session.state === "create_negative") {
    const lower = text.toLowerCase();

    if (!["yes", "no"].includes(lower)) {
      await send(chatId, "❌ Reply yes or no.");
      return true;
    }

    if (lower === "no") {
      setSession(chatId, {
        state: "create_instructions",
        draftTest: {
          ...session.draftTest,
          negative_marking_enabled: false,
          negative_marking_value: 0
        }
      });

      await send(chatId, "Enter instructions or <code>skip</code>:");
      return true;
    }

    setSession(chatId, {
      state: "create_negative_value",
      draftTest: {
        ...session.draftTest,
        negative_marking_enabled: true
      }
    });

    await send(chatId, "Enter negative marking value:");
    return true;
  }

  if (session.state === "create_negative_value") {
    const negative = Number(text);

    if (!Number.isFinite(negative) || negative < 0) {
      await send(chatId, "❌ Negative value must be 0 or greater.");
      return true;
    }

    setSession(chatId, {
      state: "create_instructions",
      draftTest: {
        ...session.draftTest,
        negative_marking_value: negative
      }
    });

    await send(chatId, "Enter instructions or <code>skip</code>:");
    return true;
  }

  if (session.state === "create_instructions") {
    let ownerId;
    try {
      ownerId = await getApplicationOwnerId();
    } catch (ownerError) {
      clearSession(chatId);
      await send(chatId, `❌ ${escapeHtml(ownerError.message)}`);
      return true;
    }

    const d = session.draftTest;
    const startsAt = d.test_date && d.test_time
      ? new Date(`${d.test_date}T${d.test_time}:00+05:30`).toISOString()
      : null;
    const endsAt = startsAt
      ? new Date(new Date(startsAt).getTime() + Number(d.duration_minutes) * 60000).toISOString()
      : null;

    const draft = {
      owner_id: ownerId,
      title: d.title,
      description: d.description,
      status: "draft",
      test_code: generateTestCode(),
      duration_minutes: d.duration_minutes,
      starts_at: startsAt,
      ends_at: endsAt,
      instructions: text.toLowerCase() === "skip" ? null : text,
      marks_per_question: d.marks_per_question,
      negative_marking_enabled: d.negative_marking_enabled,
      negative_marking_value: d.negative_marking_value,
      lobby_state: "waiting",
      instruction_countdown_seconds: 300,
      chat_enabled: false
    };

    const { data, error } = await supabase
      .from("tests")
      .insert(draft)
      .select()
      .single();

    if (error) {
      console.error(error);
      clearSession(chatId);
      await send(chatId, "❌ Could not create test.");
      return true;
    }

    clearSession(chatId);

    await send(
      chatId,
      `✅ <b>Test created successfully.</b>\n\nTest: <b>${escapeHtml(data.title)}</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❓ Add Questions",
                callback_data: `${PREFIX}questions:${data.id}`
              }
            ],
            [
              {
                text: "📚 Select Subjects",
                callback_data: `${PREFIX}tsub:${data.id}`
              }
            ],
            [
              {
                text: "📝 Test Details",
                callback_data: `${PREFIX}test:${data.id}`
              }
            ]
          ]
        }
      }
    );

    return true;
  }

  return false;
}

/* =========================================================
   EDIT TEST MENU
========================================================= */

async function showEditTestMenu(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(
      chatId,
      "🔒 This test is locked because it is no longer a draft.",
      {
        reply_markup: backKeyboard(`test:${testId}`)
      }
    );
    return;
  }

  const buttons = [
    [
      {
        text: `Title: ${shortValue(test.title)}`,
        callback_data: `${PREFIX}field:title:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Title",
        callback_data: `${PREFIX}editfield:title:${testId}`
      }
    ],
    [
      {
        text: `Description: ${shortValue(test.description)}`,
        callback_data: `${PREFIX}field:desc:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Description",
        callback_data: `${PREFIX}editfield:desc:${testId}`
      }
    ],
    [
      {
        text: `Date: ${shortValue(test.test_date)}`,
        callback_data: `${PREFIX}field:date:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Date",
        callback_data: `${PREFIX}editfield:date:${testId}`
      }
    ],
    [
      {
        text: `Time: ${shortValue(test.test_time)}`,
        callback_data: `${PREFIX}field:time:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Time",
        callback_data: `${PREFIX}editfield:time:${testId}`
      }
    ],
    [
      {
        text: `Duration: ${test.duration_minutes} min`,
        callback_data: `${PREFIX}field:duration:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Duration",
        callback_data: `${PREFIX}editfield:duration:${testId}`
      }
    ],
    [
      {
        text: `Marks/Question: ${test.marks_per_question}`,
        callback_data: `${PREFIX}field:marks:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Marks",
        callback_data: `${PREFIX}editfield:marks:${testId}`
      }
    ],
    [
      {
        text: `Negative: ${
          test.negative_marking_enabled
            ? `Yes (-${test.negative_marking_value})`
            : "No"
        }`,
        callback_data: `${PREFIX}field:negative:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Negative Marking",
        callback_data: `${PREFIX}editfield:negative:${testId}`
      }
    ],
    [
      {
        text: `Instructions: ${shortValue(test.instructions)}`,
        callback_data: `${PREFIX}field:instructions:${testId}`
      }
    ],
    [
      {
        text: "✏️ Edit Instructions",
        callback_data: `${PREFIX}editfield:instructions:${testId}`
      }
    ],
    [
      {
        text: "❓ Questions",
        callback_data: `${PREFIX}questions:${testId}`
      }
    ],
    [
      {
        text: "⬅️ Back",
        callback_data: `${PREFIX}test:${testId}`
      }
    ]
  ];

  await send(
    chatId,
    "✏️ <b>Edit Test</b>\n\nCurrent values are shown below.",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

function shortValue(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return "Not set";
  }

  const text = String(value);

  return text.length > 30
    ? `${text.slice(0, 27)}...`
    : text;
}

/* =========================================================
   EDIT TEST FIELD
========================================================= */

async function showFieldValue(chatId, testId, field) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  const values = {
    title: ["Title", test.title],
    desc: ["Description", test.description],
    date: ["Date", test.test_date],
    time: ["Time", test.test_time],
    duration: ["Duration", `${test.duration_minutes} minutes`],
    marks: ["Marks/Question", test.marks_per_question],
    negative: [
      "Negative Marking",
      test.negative_marking_enabled
        ? `Yes (-${test.negative_marking_value})`
        : "No"
    ],
    instructions: ["Instructions", test.instructions]
  };

  const item = values[field];

  if (!item) {
    await send(chatId, "❌ Invalid field.");
    return;
  }

  await send(
    chatId,
    `📌 <b>${item[0]}</b>\n\n${escapeHtml(
      item[1] ?? "Not set"
    )}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✏️ Edit",
              callback_data: `${PREFIX}editfield:${field}:${testId}`
            }
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: `${PREFIX}edit:${testId}`
            }
          ]
        ]
      }
    }
  );
}

async function startEditField(chatId, testId, field) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(chatId, "🔒 Test is locked.");
    return;
  }

  const prompts = {
    title: "Enter new title:",
    desc: "Enter new description or <code>skip</code> to clear it:",
    date: "Enter date in YYYY-MM-DD format:",
    time: "Enter time in HH:MM format:",
    duration: "Enter duration in minutes:",
    marks: "Enter marks per question:",
    negative: "Enter <code>yes</code> or <code>no</code>:",
    instructions: "Enter instructions or <code>skip</code> to clear:"
  };

  setSession(chatId, {
    state: "edit_field",
    editTestId: testId,
    editField: field
  });

  await send(chatId, prompts[field] || "Enter new value:");
}

async function processEditField(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "edit_field") {
    return false;
  }

  const text = msg.text.trim();
  const field = session.editField;
  const testId = session.editTestId;

  const update = {};

  if (field === "title") {
    if (!text) {
      await send(chatId, "❌ Title cannot be empty.");
      return true;
    }

    update.title = text;
  }

  if (field === "desc") {
    update.description =
      text.toLowerCase() === "skip" ? null : text;
  }

  if (field === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      await send(chatId, "❌ Use YYYY-MM-DD.");
      return true;
    }

    update.test_date = text;
  }

  if (field === "time") {
    if (!/^\d{1,2}:\d{2}$/.test(text)) {
      await send(chatId, "❌ Use HH:MM.");
      return true;
    }

    update.test_time = text;
  }

  if (field === "duration") {
    const value = Number(text);

    if (!Number.isInteger(value) || value <= 0) {
      await send(chatId, "❌ Duration must be positive.");
      return true;
    }

    update.duration_minutes = value;
  }

  if (field === "marks") {
    const value = Number(text);

    if (!Number.isFinite(value) || value <= 0) {
      await send(chatId, "❌ Marks must be greater than 0.");
      return true;
    }

    update.marks_per_question = value;
  }

  if (field === "negative") {
    const lower = text.toLowerCase();

    if (!["yes", "no"].includes(lower)) {
      await send(chatId, "❌ Reply yes or no.");
      return true;
    }

    if (lower === "no") {
      update.negative_marking_enabled = false;
      update.negative_marking_value = 0;
    } else {
      setSession(chatId, {
        state: "edit_negative_value",
        editTestId: testId,
        editField: field
      });

      await send(chatId, "Enter negative marking value:");
      return true;
    }
  }

  if (field === "instructions") {
    update.instructions =
      text.toLowerCase() === "skip" ? null : text;
  }

  if (Object.keys(update).length === 0) {
    return true;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      ...update,
      updated_at: new Date().toISOString()
    })
    .eq("id", testId)
    .eq("status", "draft");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not update test.");
    return true;
  }

  clearSession(chatId);

  await send(chatId, "✅ Test updated successfully.", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✏️ Edit Test",
            callback_data: `${PREFIX}edit:${testId}`
          }
        ],
        [
          {
            text: "📝 Test Details",
            callback_data: `${PREFIX}test:${testId}`
          }
        ]
      ]
    }
  });

  return true;
}

async function processEditNegativeValue(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "edit_negative_value") {
    return false;
  }

  const value = Number(msg.text.trim());

  if (!Number.isFinite(value) || value < 0) {
    await send(chatId, "❌ Value must be 0 or greater.");
    return true;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      negative_marking_enabled: true,
      negative_marking_value: value,
      updated_at: new Date().toISOString()
    })
    .eq("id", session.editTestId)
    .eq("status", "draft");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not update negative marking.");
    return true;
  }

  const testId = session.editTestId;

  clearSession(chatId);

  await send(chatId, "✅ Negative marking updated.", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✏️ Edit Test",
            callback_data: `${PREFIX}edit:${testId}`
          }
        ]
      ]
    }
  });

  return true;
}

/* =========================================================
   SUBJECTS
========================================================= */

async function showSubjects(chatId) {
  const { data, error } = await supabase
    .from("subjects")
    .select("*")
    .order("name");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load subjects.");
    return;
  }

  const buttons = (data || []).map(subject => [
    {
      text: `${subject.is_active ? "🟢" : "⚪"} ${subject.name}`,
      callback_data: `${PREFIX}subject:${subject.id}`
    }
  ]);

  buttons.push([
    {
      text: "➕ Add Subject",
      callback_data: `${PREFIX}addsub`
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
    "📚 <b>Subjects</b>\n\n🟢 Active\n⚪ Inactive",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function showSubject(chatId, subjectId) {
  const { data, error } = await supabase
    .from("subjects")
    .select("*")
    .eq("id", subjectId)
    .maybeSingle();

  if (error || !data) {
    await send(chatId, "❌ Subject not found.");
    return;
  }

  await send(
    chatId,
    `📚 <b>${escapeHtml(data.name)}</b>

Status: ${data.is_active ? "🟢 Active" : "⚪ Inactive"}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✏️ Edit",
              callback_data: `${PREFIX}editsub:${subjectId}`
            }
          ],
          [
            {
              text: data.is_active
                ? "⚪ Deactivate"
                : "🟢 Activate",
              callback_data: `${PREFIX}togsub:${subjectId}`
            }
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: `${PREFIX}subjects`
            }
          ]
        ]
      }
    }
  );
}

async function startAddSubject(chatId) {
  setSession(chatId, {
    state: "add_subject"
  });

  await send(chatId, "📚 Enter subject name:");
}

async function startEditSubject(chatId, subjectId) {
  const { data } = await supabase
    .from("subjects")
    .select("*")
    .eq("id", subjectId)
    .maybeSingle();

  if (!data) {
    await send(chatId, "❌ Subject not found.");
    return;
  }

  setSession(chatId, {
    state: "edit_subject",
    subjectId
  });

  await send(
    chatId,
    `✏️ Current name: <b>${escapeHtml(data.name)}</b>\n\nEnter new name:`
  );
}

async function processSubjectInput(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const text = msg.text.trim();

  if (!session) return false;

  if (session.state === "add_subject") {
    if (!text) {
      await send(chatId, "❌ Name cannot be empty.");
      return true;
    }

    const { error } = await supabase
      .from("subjects")
      .insert({
        name: text,
        is_active: true
      });

    if (error) {
      console.error(error);
      await send(chatId, "❌ Could not add subject.");
      return true;
    }

    clearSession(chatId);
    await send(chatId, "✅ Subject added.", {
      reply_markup: backKeyboard("subjects")
    });

    return true;
  }

  if (session.state === "edit_subject") {
    if (!text) {
      await send(chatId, "❌ Name cannot be empty.");
      return true;
    }

    const { error } = await supabase
      .from("subjects")
      .update({
        name: text
      })
      .eq("id", session.subjectId);

    if (error) {
      console.error(error);
      await send(
        chatId,
        "❌ Could not rename subject.\n\nMake sure another subject doesn't already have this name."
      );
      return true;
    }

    clearSession(chatId);

    await send(chatId, "✅ Subject renamed.", {
      reply_markup: backKeyboard("subjects")
    });

    return true;
  }

  return false;
}

/* =========================================================
   TEST SUBJECTS
========================================================= */

async function showTestSubjects(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(chatId, "🔒 Test is locked.");
    return;
  }

  const { data: subjects } = await supabase
    .from("subjects")
    .select("*")
    .eq("is_active", true)
    .order("name");

  const { data: selected } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq("test_id", testId);

  const selectedIds = new Set(
    (selected || []).map(x => x.subject_id)
  );

  const buttons = (subjects || []).map(subject => [
    {
      text: `${selectedIds.has(subject.id) ? "✅" : "⬜"} ${subject.name}`,
      callback_data: `${PREFIX}togsubtest:${testId}:${subject.id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}test:${testId}`
    }
  ]);

  await send(
    chatId,
    "📚 <b>Select Subjects</b>\n\nTap subjects to toggle them.",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function toggleTestSubject(chatId, testId, subjectId) {
  const test = await getTest(testId);

  if (!test || test.status !== "draft") {
    await send(chatId, "🔒 Test is locked.");
    return;
  }

  const { data } = await supabase
    .from("test_subjects")
    .select("*")
    .eq("test_id", testId)
    .eq("subject_id", subjectId)
    .maybeSingle();

  if (data) {
    await supabase
      .from("test_subjects")
      .delete()
      .eq("test_id", testId)
      .eq("subject_id", subjectId);
  } else {
    await supabase
      .from("test_subjects")
      .insert({
        test_id: testId,
        subject_id: subjectId
      });
  }

  await showTestSubjects(chatId, testId);
}

/* =========================================================
   QUESTION BUILDER
========================================================= */

async function showQuestionMenu(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  const locked = test.status !== "draft";

  await send(
    chatId,
    `❓ <b>Question Builder</b>

Test: <b>${escapeHtml(test.title)}</b>
Questions: ${test.total_questions}
Total Marks: ${test.total_marks}

${
  locked
    ? "🔒 This test is locked."
    : "Choose an action:"
}`,
    {
      reply_markup: {
        inline_keyboard: [
          ...(locked
            ? []
            : [
                [
                  {
                    text: "➕ Add Question",
                    callback_data: `${PREFIX}addq:${testId}`
                  }
                ]
              ]),
          [
            {
              text: "📋 View Questions",
              callback_data: `${PREFIX}viewq:${testId}`
            }
          ],
          ...(locked
            ? []
            : [
                [
                  {
                    text: "✏️ Edit Question",
                    callback_data: `${PREFIX}editqmenu:${testId}`
                  }
                ],
                [
                  {
                    text: "🗑️ Delete Question",
                    callback_data: `${PREFIX}delqmenu:${testId}`
                  }
                ]
              ]),
          [
            {
              text: "⬅️ Back",
              callback_data: `${PREFIX}test:${testId}`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   ADD QUESTION
========================================================= */

async function startAddQuestion(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(chatId, "🔒 Published/ended tests cannot be edited.");
    return;
  }

  const { count } = await supabase
    .from("questions")
    .select("*", {
      count: "exact",
      head: true
    })
    .eq("test_id", testId);

  const nextNumber = (count || 0) + 1;

  setSession(chatId, {
    state: "question_type",
    questionMode: "add",
    testId,
    questionNumber: nextNumber,
    questionData: {}
  });

  await send(
    chatId,
    `➕ <b>Add Question ${nextNumber}</b>\n\nSelect question type:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 MCQ",
              callback_data: `${PREFIX}qtype:mcq`
            }
          ],
          [
            {
              text: "☑️ Multiple Correct",
              callback_data: `${PREFIX}qtype:multiple_correct`
            }
          ],
          [
            {
              text: "🔢 Numerical",
              callback_data: `${PREFIX}qtype:numerical`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: `${PREFIX}questions:${testId}`
            }
          ]
        ]
      }
    }
  );
}

async function chooseQuestionType(chatId, type) {
  const session = getSession(chatId);

  if (!session || session.state !== "question_type") {
    await send(chatId, "❌ Question session expired. Start again.");
    return;
  }

  setSession(chatId, {
    state: "question_text",
    questionData: {
      ...session.questionData,
      question_type: type
    }
  });

  await send(
    chatId,
    `📝 <b>Question ${session.questionNumber}</b>\n\nEnter question text:`
  );
}

async function processQuestionBuilder(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session) return false;

  if (session.state === "question_text") {
    const text = msg.text.trim();

    if (!text) {
      await send(chatId, "❌ Question text cannot be empty.");
      return true;
    }

    setSession(chatId, {
      state:
        session.questionData.question_type === "numerical"
          ? "question_marks"
          : "question_option_a",
      questionData: {
        ...session.questionData,
        question_text: text
      }
    });

    if (
      session.questionData.question_type === "numerical"
    ) {
      await send(chatId, "Enter marks:");
    } else {
      await send(chatId, "Enter option A:");
    }

    return true;
  }

  if (
    session.state === "question_option_a" ||
    session.state === "question_option_b" ||
    session.state === "question_option_c" ||
    session.state === "question_option_d"
  ) {
    const text = msg.text.trim();

    if (!text) {
      await send(chatId, "❌ Option cannot be empty.");
      return true;
    }

    const optionKey = {
      question_option_a: "A",
      question_option_b: "B",
      question_option_c: "C",
      question_option_d: "D"
    }[session.state];

    const options = {
      ...(session.questionData.options || {}),
      [optionKey]: text
    };

    const nextState = {
      question_option_a: "question_option_b",
      question_option_b: "question_option_c",
      question_option_c: "question_option_d",
      question_option_d: "question_marks"
    }[session.state];

    setSession(chatId, {
      state: nextState,
      questionData: {
        ...session.questionData,
        options
      }
    });

    if (nextState === "question_marks") {
      await send(chatId, "Enter marks:");
    } else {
      const nextLetter = {
        question_option_b: "B",
        question_option_c: "C",
        question_option_d: "D"
      }[nextState];

      await send(chatId, `Enter option ${nextLetter}:`);
    }

    return true;
  }

  if (session.state === "question_marks") {
    const marks = Number(msg.text.trim());

    if (!Number.isFinite(marks) || marks <= 0) {
      await send(chatId, "❌ Marks must be greater than 0.");
      return true;
    }

    setSession(chatId, {
      state: "question_negative",
      questionData: {
        ...session.questionData,
        marks
      }
    });

    await send(chatId, "Enter negative marks (0 allowed):");
    return true;
  }

  if (session.state === "question_negative") {
    const negative = Number(msg.text.trim());

    if (!Number.isFinite(negative) || negative < 0) {
      await send(chatId, "❌ Negative marks cannot be negative.");
      return true;
    }

    const data = {
      ...session.questionData,
      negative_marks: negative
    };

    const { data: question, error } = await supabase
      .from("questions")
      .insert({
        test_id: session.testId,
        question_number: session.questionNumber,
        question_text: data.question_text,
        question_type: data.question_type,
        marks: data.marks,
        negative_marks: data.negative_marks
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      await send(chatId, "❌ Could not save question.");
      return true;
    }

    if (
      data.question_type === "mcq" ||
      data.question_type === "multiple_correct"
    ) {
      const letters = ["A", "B", "C", "D"];

      const optionRows = letters.map((letter, index) => ({
        question_id: question.id,
        option_label: letter,
        option_text: data.options[letter],
        option_order: index + 1
      }));

      const { error: optionError } = await supabase
        .from("question_options")
        .insert(optionRows);

      if (optionError) {
        console.error(optionError);

        await supabase
          .from("questions")
          .delete()
          .eq("id", question.id);

        await send(chatId, "❌ Could not save options.");
        return true;
      }
    }

    await recalculateTestTotals(session.testId);

    const testId = session.testId;
    clearSession(chatId);

    await send(
      chatId,
      `✅ <b>Question ${question.question_number} saved.</b>

Type: ${data.question_type}
Marks: ${data.marks}
Negative: ${data.negative_marks}

Correct answer is NOT entered here.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add Another",
                callback_data: `${PREFIX}addq:${testId}`
              }
            ],
            [
              {
                text: "📋 View Questions",
                callback_data: `${PREFIX}viewq:${testId}`
              }
            ],
            [
              {
                text: "⬅️ Question Builder",
                callback_data: `${PREFIX}questions:${testId}`
              }
            ]
          ]
        }
      }
    );

    return true;
  }

  return false;
}

/* =========================================================
   VIEW QUESTIONS
========================================================= */

async function viewQuestions(chatId, testId, page = 0) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  const pageSize = 5;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  const {
    data,
    error,
    count
  } = await supabase
    .from("questions")
    .select("*", {
      count: "exact"
    })
    .eq("test_id", testId)
    .order("question_number")
    .range(from, to);

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load questions.");
    return;
  }

  if (!data?.length) {
    await send(
      chatId,
      "📋 <b>Questions</b>\n\nNo questions added yet.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add Question",
                callback_data: `${PREFIX}addq:${testId}`
              }
            ],
            [
              {
                text: "⬅️ Back",
                callback_data: `${PREFIX}questions:${testId}`
              }
            ]
          ]
        }
      }
    );

    return;
  }

  let text = `📋 <b>Questions</b>\n\n`;

  for (const q of data) {
    text += `<b>Q${q.question_number}</b> [${q.question_type}]\n`;
    text += `${escapeHtml(q.question_text.slice(0, 120))}\n`;
    text += `Marks: ${q.marks} | Negative: ${q.negative_marks}\n\n`;
  }

  const buttons = [];

  if (page > 0) {
    buttons.push([
      {
        text: "⬅️ Previous",
        callback_data: `${PREFIX}viewq:${testId}:${page - 1}`
      }
    ]);
  }

  if (count && to + 1 < count) {
    buttons.push([
      {
        text: "Next ➡️",
        callback_data: `${PREFIX}viewq:${testId}:${page + 1}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Question Builder",
      callback_data: `${PREFIX}questions:${testId}`
    }
  ]);

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

/* =========================================================
   EDIT QUESTION MENU
========================================================= */

async function showEditQuestionMenu(chatId, testId) {
  const { data, error } = await supabase
    .from("questions")
    .select("*")
    .eq("test_id", testId)
    .order("question_number");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load questions.");
    return;
  }

  if (!data?.length) {
    await send(chatId, "❌ No questions to edit.");
    return;
  }

  const buttons = data.map(q => [
    {
      text: `Q${q.question_number} — ${q.question_type}`,
      callback_data: `${PREFIX}editoneq:${q.id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}questions:${testId}`
    }
  ]);

  await send(
    chatId,
    "✏️ <b>Edit Question</b>\n\nSelect a question:",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function showEditQuestion(chatId, questionId) {
  const { data: question } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const test = await getTest(question.test_id);

  if (!test || test.status !== "draft") {
    await send(chatId, "🔒 Question is locked.");
    return;
  }

  const { data: options } = await supabase
    .from("question_options")
    .select("*")
    .eq("question_id", questionId)
    .order("option_order");

  let text = `✏️ <b>Question ${question.question_number}</b>

<b>Type:</b> ${question.question_type}
<b>Question:</b>
${escapeHtml(question.question_text)}

<b>Marks:</b> ${question.marks}
<b>Negative:</b> ${question.negative_marks}`;

  if (options?.length) {
    text += "\n\n";

    for (const option of options) {
      text += `${option.option_label}. ${escapeHtml(option.option_text)}\n`;
    }
  }

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📝 Edit Text",
            callback_data: `${PREFIX}eqtext:${questionId}`
          }
        ],
        [
          {
            text: "💯 Edit Marks",
            callback_data: `${PREFIX}eqmarks:${questionId}`
          }
        ],
        [
          {
            text: "➖ Edit Negative",
            callback_data: `${PREFIX}eqneg:${questionId}`
          }
        ],
        ...(options?.length
          ? [
              [
                {
                  text: "🔤 Edit Options",
                  callback_data: `${PREFIX}eqopts:${questionId}`
                }
              ]
            ]
          : []),
        [
          {
            text: "⬅️ Back",
            callback_data: `${PREFIX}editqmenu:${question.test_id}`
          }
        ]
      ]
    }
  });
}

async function startQuestionEdit(chatId, questionId, field) {
  const { data: question } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const test = await getTest(question.test_id);

  if (!test || test.status !== "draft") {
    await send(chatId, "🔒 Question is locked.");
    return;
  }

  const states = {
    text: "edit_q_text",
    marks: "edit_q_marks",
    neg: "edit_q_neg"
  };

  setSession(chatId, {
    state: states[field],
    questionId,
    testId: question.test_id
  });

  if (field === "text") {
    await send(
      chatId,
      `Current text:\n\n${escapeHtml(question.question_text)}\n\nEnter new question text:`
    );
  }

  if (field === "marks") {
    await send(
      chatId,
      `Current marks: <b>${question.marks}</b>\n\nEnter new marks:`
    );
  }

  if (field === "neg") {
    await send(
      chatId,
      `Current negative marks: <b>${question.negative_marks}</b>\n\nEnter new negative marks:`
    );
  }
}

async function processQuestionEdit(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session) return false;

  if (
    ![
      "edit_q_text",
      "edit_q_marks",
      "edit_q_neg"
    ].includes(session.state)
  ) {
    return false;
  }

  const text = msg.text.trim();

  const update = {};

  if (session.state === "edit_q_text") {
    if (!text) {
      await send(chatId, "❌ Question text cannot be empty.");
      return true;
    }

    update.question_text = text;
  }

  if (session.state === "edit_q_marks") {
    const value = Number(text);

    if (!Number.isFinite(value) || value <= 0) {
      await send(chatId, "❌ Marks must be greater than 0.");
      return true;
    }

    update.marks = value;
  }

  if (session.state === "edit_q_neg") {
    const value = Number(text);

    if (!Number.isFinite(value) || value < 0) {
      await send(chatId, "❌ Negative marks cannot be negative.");
      return true;
    }

    update.negative_marks = value;
  }

  const { error } = await supabase
    .from("questions")
    .update(update)
    .eq("id", session.questionId);

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not update question.");
    return true;
  }

  await recalculateTestTotals(session.testId);

  const questionId = session.questionId;

  clearSession(chatId);

  await send(chatId, "✅ Question updated.", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✏️ Continue Editing",
            callback_data: `${PREFIX}editoneq:${questionId}`
          }
        ],
        [
          {
            text: "⬅️ Question Builder",
            callback_data: `${PREFIX}questions:${session.testId}`
          }
        ]
      ]
    }
  });

  return true;
}

/* =========================================================
   EDIT OPTIONS
========================================================= */

async function showEditOptions(chatId, questionId) {
  const { data: question } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const { data: options } = await supabase
    .from("question_options")
    .select("*")
    .eq("question_id", questionId)
    .order("option_order");

  const buttons = (options || []).map(option => [
    {
      text: `${option.option_label}: ${shortValue(option.option_text)}`,
      callback_data: `${PREFIX}editopt:${option.id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}editoneq:${questionId}`
    }
  ]);

  await send(chatId, "🔤 <b>Edit Options</b>\n\nSelect an option:", {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

async function startEditOption(chatId, optionId) {
  const { data: option } = await supabase
    .from("question_options")
    .select("*")
    .eq("id", optionId)
    .maybeSingle();

  if (!option) {
    await send(chatId, "❌ Option not found.");
    return;
  }

  const { data: question } = await supabase
    .from("questions")
    .select("test_id")
    .eq("id", option.question_id)
    .maybeSingle();

  setSession(chatId, {
    state: "edit_option",
    optionId,
    questionId: option.question_id,
    testId: question?.test_id
  });

  await send(
    chatId,
    `Current ${option.option_label}:\n\n${escapeHtml(option.option_text)}\n\nEnter new option text:`
  );
}

async function processEditOption(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session || session.state !== "edit_option") {
    return false;
  }

  const text = msg.text.trim();

  if (!text) {
    await send(chatId, "❌ Option cannot be empty.");
    return true;
  }

  const { error } = await supabase
    .from("question_options")
    .update({
      option_text: text
    })
    .eq("id", session.optionId);

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not update option.");
    return true;
  }

  const questionId = session.questionId;

  clearSession(chatId);

  await send(chatId, "✅ Option updated.", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🔤 Edit Options",
            callback_data: `${PREFIX}eqopts:${questionId}`
          }
        ],
        [
          {
            text: "⬅️ Question",
            callback_data: `${PREFIX}editoneq:${questionId}`
          }
        ]
      ]
    }
  });

  return true;
}

/* =========================================================
   DELETE QUESTION
========================================================= */

async function showDeleteQuestionMenu(chatId, testId) {
  const { data, error } = await supabase
    .from("questions")
    .select("id, question_number, question_text")
    .eq("test_id", testId)
    .order("question_number");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load questions.");
    return;
  }

  if (!data?.length) {
    await send(chatId, "❌ No questions to delete.");
    return;
  }

  const buttons = data.map(q => [
    {
      text: `🗑️ Q${q.question_number}`,
      callback_data: `${PREFIX}confirmdel:${q.id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: `${PREFIX}questions:${testId}`
    }
  ]);

  await send(
    chatId,
    "🗑️ <b>Delete Question</b>\n\nSelect a question:",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

async function confirmDeleteQuestion(chatId, questionId) {
  const { data: question } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  await send(
    chatId,
    `⚠️ <b>Delete Question ${question.question_number}?</b>

${escapeHtml(question.question_text)}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑️ Yes, Delete",
              callback_data: `${PREFIX}doDelete:${questionId}`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: `${PREFIX}delqmenu:${question.test_id}`
            }
          ]
        ]
      }
    }
  );
}

async function deleteQuestion(chatId, questionId) {
  const { data: question, error: questionError } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();

  if (questionError) {
    console.error(questionError);
    await send(chatId, "❌ Could not find question.");
    return;
  }

  if (!question) {
    await send(chatId, "❌ Question not found.");
    return;
  }

  const test = await getTest(question.test_id);

  if (!test || test.status !== "draft") {
    await send(chatId, "🔒 Test is locked.");
    return;
  }

  const { error: deleteError } = await supabase
    .from("questions")
    .delete()
    .eq("id", questionId);

  if (deleteError) {
    console.error(deleteError);
    await send(chatId, "❌ Could not delete question.");
    return;
  }

  const { data: remaining, error: remainingError } =
    await supabase
      .from("questions")
      .select("id")
      .eq("test_id", question.test_id)
      .order("question_number");

  if (remainingError) {
    console.error(remainingError);
  } else {
    /*
      Temporary numbering avoids UNIQUE(test_id, question_number)
      conflicts while renumbering.
    */

    for (let i = 0; i < remaining.length; i++) {
      await supabase
        .from("questions")
        .update({
          question_number: -(i + 1)
        })
        .eq("id", remaining[i].id);
    }

    for (let i = 0; i < remaining.length; i++) {
      await supabase
        .from("questions")
        .update({
          question_number: i + 1
        })
        .eq("id", remaining[i].id);
    }
  }

  await recalculateTestTotals(question.test_id);

  await send(
    chatId,
    `✅ Question ${question.question_number} deleted.\n\nRemaining questions have been renumbered.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❓ Question Builder",
              callback_data: `${PREFIX}questions:${question.test_id}`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   TEST TOTALS
========================================================= */

async function recalculateTestTotals(testId) {
  const { data: questions, error } = await supabase
    .from("questions")
    .select("marks")
    .eq("test_id", testId);

  if (error) {
    console.error("Totals error:", error);
    return;
  }

  const totalQuestions = questions?.length || 0;

  const totalMarks = (questions || []).reduce(
    (sum, q) => sum + Number(q.marks || 0),
    0
  );

  const { error: updateError } = await supabase
    .from("tests")
    .update({
      total_questions: totalQuestions,
      total_marks: totalMarks,
      updated_at: new Date().toISOString()
    })
    .eq("id", testId);

  if (updateError) {
    console.error(updateError);
  }
}

/* =========================================================
   PUBLISH / END
========================================================= */

async function publishTest(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "draft") {
    await send(chatId, "❌ Only draft tests can be published.");
    return;
  }

  if (!test.total_questions) {
    await send(
      chatId,
      "❌ Add at least one question before publishing."
    );
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "published",
      updated_at: new Date().toISOString()
    })
    .eq("id", testId)
    .eq("status", "draft");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not publish test.");
    return;
  }

  await send(
    chatId,
    `🚀 <b>Test Published</b>

${escapeHtml(test.title)}

Questions: ${test.total_questions}
Total Marks: ${test.total_marks}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📝 Test Details",
              callback_data: `${PREFIX}test:${testId}`
            }
          ]
        ]
      }
    }
  );
}

async function endTest(chatId, testId) {
  const test = await getTest(testId);

  if (!test) {
    await send(chatId, "❌ Test not found.");
    return;
  }

  if (test.status !== "published") {
    await send(chatId, "❌ Only published tests can be ended.");
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "published",
      lobby_state: "ended",
      updated_at: new Date().toISOString()
    })
    .eq("id", testId)
    .eq("status", "published")
    .neq("lobby_state", "ended");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not end test.");
    return;
  }

  await send(
    chatId,
    `🔴 <b>Test Ended</b>

${escapeHtml(test.title)}

The test is now locked for editing.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📝 Test Details",
              callback_data: `${PREFIX}test:${testId}`
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

async function showAdmins(chatId, admin) {
  if (admin.role !== "owner") {
    await send(
      chatId,
      "⛔ Only the owner can manage admins.",
      {
        reply_markup: backKeyboard("panel")
      }
    );
    return;
  }

  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_user_id, role, is_active, created_at")
    .order("created_at");

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load admins.");
    return;
  }

  let text = "👥 <b>Admins</b>\n\n";

  for (const a of data || []) {
    text += `${a.role === "owner" ? "👑" : "👤"} <code>${a.telegram_user_id}</code> — ${a.role} — ${
      a.is_active ? "Active" : "Inactive"
    }\n`;
  }

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "➕ Add Admin",
            callback_data: `${PREFIX}addadmin`
          }
        ],
        [
          {
            text: "⚙️ Manage Admins",
            callback_data: `${PREFIX}manageadmins`
          }
        ],
        [
          {
            text: "⬅️ Back",
            callback_data: `${PREFIX}panel`
          }
        ]
      ]
    }
  });
}

async function startAddAdmin(chatId) {
  const session = getSession(chatId) || {};
  setSession(chatId, {
    ...session,
    state: "admin_id"
  });

  await send(
    chatId,
    "👤 Enter the new admin's Telegram numeric ID:"
  );
}

async function processAdminInput(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session) return false;

  if (session.state === "admin_id") {
    const id = Number(msg.text.trim());

    if (!Number.isSafeInteger(id) || id <= 0) {
      await send(chatId, "❌ Invalid Telegram ID.");
      return true;
    }

    setSession(chatId, {
      state: "admin_password",
      newAdminId: id
    });

    await send(chatId, "Enter password for this admin:");
    return true;
  }

  if (session.state === "admin_change_password") {
    const password = msg.text.trim();

    if (password.length < 6) {
      await send(chatId, "❌ Password must be at least 6 characters.");
      return true;
    }

    const { error } = await supabase
      .from("telegram_admins")
      .update({
        password_hash: hashPassword(password),
        updated_at: new Date().toISOString()
      })
      .eq("telegram_user_id", session.targetAdminId)
      .eq("role", "admin");

    if (error) {
      console.error(error);
      await send(chatId, "❌ Could not change admin password.");
      return true;
    }

    const adminRole = session.adminRole;
    const authUserId = session.authUserId;
    clearSession(chatId);
    setSession(chatId, {
      loggedIn: true,
      authUserId,
      adminRole,
      state: null
    });

    await send(chatId, "✅ Admin password changed.", {
      reply_markup: {
        inline_keyboard: [[
          { text: "⚙️ Manage Admins", callback_data: `${PREFIX}manageadmins` }
        ]]
      }
    });
    return true;
  }

  if (session.state === "admin_password") {
    const password = msg.text.trim();

    if (password.length < 6) {
      await send(
        chatId,
        "❌ Password should be at least 6 characters."
      );
      return true;
    }

    const { error } = await supabase
      .from("telegram_admins")
      .upsert({
        telegram_user_id: session.newAdminId,
        role: "admin",
        password_hash: hashPassword(password),
        is_active: true,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error(error);
      await send(chatId, "❌ Could not create admin.");
      return true;
    }

    setSession(chatId, {
      loggedIn: true,
      authUserId: session.authUserId,
      adminRole: session.adminRole,
      state: null
    });

    await send(
      chatId,
      `✅ Admin <code>${session.newAdminId}</code> created successfully.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "⚙️ Manage Admins", callback_data: `${PREFIX}manageadmins` }
          ]]
        }
      }
    );

    return true;
  }

  return false;
}


async function showAdminList(chatId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_user_id, role, is_active, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load admin accounts.");
    return;
  }

  let text = "👥 <b>Admin Accounts</b>\n\n";

  for (const admin of data || []) {
    text += `${admin.role === "owner" ? "👑" : "👤"} <code>${admin.telegram_user_id}</code> — ${admin.role} — ${
      admin.is_active ? "🟢 Active" : "⚪ Inactive"
    }\n`;
  }

  await send(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Admin", callback_data: `${PREFIX}addadmin` }],
        [{ text: "⚙️ Manage Admin", callback_data: `${PREFIX}manageadmins` }],
        [{ text: "⬅️ Back", callback_data: `${PREFIX}panel` }]
      ]
    }
  });
}

async function showManageAdminList(chatId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_user_id, role, is_active")
    .eq("role", "admin")
    .order("telegram_user_id", { ascending: true });

  if (error) {
    console.error(error);
    await send(chatId, "❌ Could not load admins.");
    return;
  }

  const rows = (data || []).map(a => [{
    text: `${a.is_active ? "🟢" : "⚪"} ${a.telegram_user_id}`,
    callback_data: `${PREFIX}manageadmin:${a.telegram_user_id}`
  }]);

  rows.push([{ text: "⬅️ Back", callback_data: `${PREFIX}admins` }]);

  await send(
    chatId,
    data?.length ? "⚙️ <b>Manage Admins</b>\n\nSelect an admin:" : "No admin accounts found.",
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function showOneAdmin(chatId, targetId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_user_id, role, is_active")
    .eq("telegram_user_id", targetId)
    .maybeSingle();

  if (error || !data) {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  if (data.role === "owner") {
    await send(chatId, "👑 <b>Owner</b>\n\nThe owner account cannot be changed, disabled, or removed.");
    return;
  }

  await send(
    chatId,
    `👤 <b>Admin</b>\n\nID: <code>${data.telegram_user_id}</code>\nStatus: ${
      data.is_active ? "🟢 Active" : "⚪ Inactive"
    }`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔑 Change Password", callback_data: `${PREFIX}adminpass:${targetId}` }],
          [{ text: data.is_active ? "🚫 Disable" : "✅ Enable", callback_data: `${PREFIX}admintoggle:${targetId}` }],
          [{ text: "🗑️ Remove", callback_data: `${PREFIX}adminremove:${targetId}` }],
          [{ text: "⬅️ Back", callback_data: `${PREFIX}manageadmins` }]
        ]
      }
    }
  );
}

async function startAdminPasswordChange(chatId, targetId) {
  const target = await supabase
    .from("telegram_admins")
    .select("role")
    .eq("telegram_user_id", targetId)
    .maybeSingle();

  if (target.error || !target.data || target.data.role !== "admin") {
    await send(chatId, "❌ Admin not found.");
    return;
  }

  setSession(chatId, {
    state: "admin_change_password",
    authUserId: getSession(chatId)?.authUserId,
    adminRole: getSession(chatId)?.adminRole,
    targetAdminId: Number(targetId)
  });

  await send(chatId, "🔑 <b>Change Admin Password</b>\n\nEnter the new password (minimum 6 characters):");
}

/* =========================================================
   CALLBACK ROUTER
========================================================= */

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id;
  const data = query.data || "";

  await bot.answerCallbackQuery(query.id).catch(() => {});

  const admin = await requireCallbackAuth(query);

  if (!admin) return;

  if (!data.startsWith(PREFIX)) return;

  const payload = data.slice(PREFIX.length);

  try {
    if (payload === "logout") {
      clearSession(chatId);
      await send(chatId, "🚪 <b>Logged out.</b>\n\nUse /start to authenticate again.");
      return;
    }

    if (payload === "panel") {
      await showPanel(chatId);
      return;
    }

    if (payload === "help") {
      await showHelp(chatId);
      return;
    }

    if (payload === "tests") {
      await showTests(chatId);
      return;
    }

    if (payload === "subjects") {
      await showSubjects(chatId);
      return;
    }

    if (payload === "admins") {
      await showAdmins(chatId, admin);
      return;
    }

    if (payload === "create") {
      await startCreateTest(chatId);
      return;
    }

    if (payload === "addsub") {
      await startAddSubject(chatId);
      return;
    }

    if (payload.startsWith("subject:")) {
      const subjectId = payload.split(":")[1];
      await showSubject(chatId, subjectId);
      return;
    }

    if (payload.startsWith("editsub:")) {
      const subjectId = payload.split(":")[1];
      await startEditSubject(chatId, subjectId);
      return;
    }

    if (payload.startsWith("togsub:")) {
      const subjectId = payload.split(":")[1];

      const { data: subject } = await supabase
        .from("subjects")
        .select("is_active")
        .eq("id", subjectId)
        .maybeSingle();

      if (subject) {
        await supabase
          .from("subjects")
          .update({
            is_active: !subject.is_active
          })
          .eq("id", subjectId);
      }

      await showSubject(chatId, subjectId);
      return;
    }

    if (payload.startsWith("test:")) {
      const testId = payload.split(":")[1];
      await showTestDetail(chatId, testId);
      return;
    }

    if (payload.startsWith("edit:")) {
      const testId = payload.split(":")[1];
      await showEditTestMenu(chatId, testId);
      return;
    }

    if (payload.startsWith("field:")) {
      const [, field, testId] = payload.split(":");
      await showFieldValue(chatId, testId, field);
      return;
    }

    if (payload.startsWith("editfield:")) {
      const [, field, testId] = payload.split(":");
      await startEditField(chatId, testId, field);
      return;
    }

    if (payload.startsWith("tsub:")) {
      const testId = payload.split(":")[1];
      await showTestSubjects(chatId, testId);
      return;
    }

    if (payload.startsWith("togsubtest:")) {
      const parts = payload.split(":");

      const testId = parts[1];
      const subjectId = parts[2];

      await toggleTestSubject(
        chatId,
        testId,
        subjectId
      );

      return;
    }

    /* QUESTIONS */

    if (payload.startsWith("questions:")) {
      const testId = payload.split(":")[1];
      await showQuestionMenu(chatId, testId);
      return;
    }

    if (payload.startsWith("addq:")) {
      const testId = payload.split(":")[1];
      await startAddQuestion(chatId, testId);
      return;
    }

    if (payload.startsWith("qtype:")) {
      const type = payload.split(":")[1];
      await chooseQuestionType(chatId, type);
      return;
    }

    if (payload.startsWith("viewq:")) {
      const parts = payload.split(":");
      const testId = parts[1];
      const page = Number(parts[2] || 0);

      await viewQuestions(
        chatId,
        testId,
        Number.isInteger(page) ? page : 0
      );

      return;
    }

    if (payload.startsWith("editqmenu:")) {
      const testId = payload.split(":")[1];
      await showEditQuestionMenu(chatId, testId);
      return;
    }

    if (payload.startsWith("editoneq:")) {
      const questionId = payload.split(":")[1];
      await showEditQuestion(chatId, questionId);
      return;
    }

    if (payload.startsWith("eqtext:")) {
      const questionId = payload.split(":")[1];
      await startQuestionEdit(
        chatId,
        questionId,
        "text"
      );
      return;
    }

    if (payload.startsWith("eqmarks:")) {
      const questionId = payload.split(":")[1];
      await startQuestionEdit(
        chatId,
        questionId,
        "marks"
      );
      return;
    }

    if (payload.startsWith("eqneg:")) {
      const questionId = payload.split(":")[1];
      await startQuestionEdit(
        chatId,
        questionId,
        "neg"
      );
      return;
    }

    if (payload.startsWith("eqopts:")) {
      const questionId = payload.split(":")[1];
      await showEditOptions(chatId, questionId);
      return;
    }

    if (payload.startsWith("editopt:")) {
      const optionId = payload.split(":")[1];
      await startEditOption(chatId, optionId);
      return;
    }

    if (payload.startsWith("delqmenu:")) {
      const testId = payload.split(":")[1];
      await showDeleteQuestionMenu(chatId, testId);
      return;
    }

    if (payload.startsWith("confirmdel:")) {
      const questionId = payload.split(":")[1];
      await confirmDeleteQuestion(chatId, questionId);
      return;
    }

    if (payload.startsWith("doDelete:")) {
      const questionId = payload.split(":")[1];
      await deleteQuestion(chatId, questionId);
      return;
    }

    /* PUBLISH / END */

    if (payload.startsWith("publish:")) {
      const testId = payload.split(":")[1];
      await publishTest(chatId, testId);
      return;
    }

    if (payload.startsWith("end:")) {
      const testId = payload.split(":")[1];
      await endTest(chatId, testId);
      return;
    }

    /* ADMINS */

    if (payload === "addadmin") {
      if (admin.role !== "owner") {
        await send(chatId, "⛔ Owner only.");
        return;
      }

      await startAddAdmin(chatId);
      return;
    }

    if (payload === "manageadmins") {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner only.");
        return;
      }
      await showAdminList(chatId);
      return;
    }

    if (payload.startsWith("manageadmin:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner only.");
        return;
      }
      await showOneAdmin(chatId, payload.split(":")[1]);
      return;
    }

    if (payload.startsWith("adminpass:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner only.");
        return;
      }
      await startAdminPasswordChange(chatId, payload.split(":")[1]);
      return;
    }

    if (payload.startsWith("admintoggle:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner only.");
        return;
      }

      const targetId = Number(payload.split(":")[1]);
      const { data: target, error: targetError } = await supabase
        .from("telegram_admins")
        .select("role,is_active")
        .eq("telegram_user_id", targetId)
        .maybeSingle();

      if (targetError || !target) {
        await send(chatId, "❌ Admin not found.");
        return;
      }
      if (target.role === "owner") {
        await send(chatId, "⛔ Owner cannot be disabled.");
        return;
      }

      const { error } = await supabase
        .from("telegram_admins")
        .update({ is_active: !target.is_active, updated_at: new Date().toISOString() })
        .eq("telegram_user_id", targetId)
        .eq("role", "admin");

      if (error) {
        await send(chatId, "❌ Could not update admin status.");
        return;
      }
      await showManageAdminList(chatId);
      return;
    }

    if (payload.startsWith("adminremove:")) {
      if (!isOwner(admin)) {
        await send(chatId, "⛔ Owner only.");
        return;
      }

      const targetId = Number(payload.split(":")[1]);
      const { data: target, error: targetError } = await supabase
        .from("telegram_admins")
        .select("role")
        .eq("telegram_user_id", targetId)
        .maybeSingle();

      if (targetError || !target) {
        await send(chatId, "❌ Admin not found.");
        return;
      }
      if (target.role === "owner") {
        await send(chatId, "⛔ Owner cannot be removed.");
        return;
      }

      const { error } = await supabase
        .from("telegram_admins")
        .delete()
        .eq("telegram_user_id", targetId)
        .eq("role", "admin");

      if (error) {
        await send(chatId, "❌ Could not remove admin.");
        return;
      }
      await showManageAdminList(chatId);
      return;
    }

  } catch (error) {
    console.error("Callback error:", error);

    await send(
      chatId,
      "❌ Something went wrong while processing that action."
    );
  }
});

/* =========================================================
   TEXT MESSAGE ROUTER
========================================================= */

bot.on("message", async msg => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    await startLogin(chatId, msg.from.id);
    return;
  }

  if (text === "/cancel") {
    clearSession(chatId);

    await send(
      chatId,
      "❌ Current operation cancelled."
    );

    return;
  }

  if (text === "/help") {
    const admin = await requireAuth(msg);

    if (admin) {
      await showHelp(chatId);
    }

    return;
  }

  const session = getSession(chatId);

  if (!session) {
    await startLogin(chatId, msg.from.id);
    return;
  }

  if (
    session.state === "password"
  ) {
    await processPassword(msg);
    return;
  }

  if (!sessionIsAuthenticated(chatId, msg.from.id)) {
    clearSession(chatId);
    await startLogin(chatId, msg.from.id);
    return;
  }

  try {
    if (await processCreateTest(msg)) return;

    if (await processEditField(msg)) return;

    if (await processEditNegativeValue(msg)) return;

    if (await processSubjectInput(msg)) return;

    if (await processQuestionBuilder(msg)) return;

    if (await processQuestionEdit(msg)) return;

    if (await processEditOption(msg)) return;

    if (await processAdminInput(msg)) return;

    await send(
      chatId,
      "Use the buttons below to continue.",
      {
        reply_markup: mainKeyboard()
      }
    );
  } catch (error) {
    console.error("Message handler error:", error);

    await send(
      chatId,
      "❌ Something went wrong. Use /cancel and try again."
    );
  }
});

/* =========================================================
   COMMANDS
========================================================= */

bot.onText(/^\/cancel$/, async msg => {
  clearSession(msg.chat.id);

  await send(
    msg.chat.id,
    "❌ Current operation cancelled."
  );
});

/* =========================================================
   STARTUP
========================================================= */

(async () => {
  try {
    await ensureOwnerAccount();

    console.log("=================================");
    console.log("PrepArena Admin Bot started");
    console.log("Polling mode: ON");
    console.log("=================================");
  } catch (error) {
    console.error("Startup error:", error);
    process.exit(1);
  }
})();

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});
