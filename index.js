const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// ============================================================
// ENV
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

const OWNER_ID = 8256722518;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing");
if (!SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is missing");
}
if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD is missing");
}

// ============================================================
// CLIENTS
// ============================================================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
});

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY
);

console.log("PrepArena Admin Bot starting...");

// ============================================================
// SESSION STORAGE
// ============================================================

/*
  Every admin action requires authentication.

  sessions:
  telegramUserId -> {
    authenticated: true,
    role: "owner" | "admin",
    state: ...
  }
*/

const sessions = new Map();

function getSession(userId) {
  return sessions.get(String(userId)) || null;
}

function setSession(userId, data) {
  sessions.set(String(userId), data);
}

function clearSession(userId) {
  sessions.delete(String(userId));
}

// ============================================================
// PASSWORD HASHING
// ============================================================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const derivedKey = crypto.scryptSync(
    password,
    salt,
    64
  );

  return `${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash).split(":");

    if (parts.length !== 2) {
      return false;
    }

    const salt = parts[0];
    const storedKey = Buffer.from(parts[1], "hex");

    const derivedKey = crypto.scryptSync(
      password,
      salt,
      64
    );

    if (storedKey.length !== derivedKey.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      storedKey,
      derivedKey
    );
  } catch {
    return false;
  }
}

// ============================================================
// TELEGRAM HELPERS
// ============================================================

async function safeSend(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(
      "Telegram send error:",
      error.message
    );
    return null;
  }
}

async function safeEdit(
  chatId,
  messageId,
  text,
  options = {}
) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...options,
    });
  } catch (error) {
    // Telegram throws if the message content is unchanged.
    if (
      !String(error.message).includes(
        "message is not modified"
      )
    ) {
      console.error(
        "Telegram edit error:",
        error.message
      );
    }

    return null;
  }
}

async function answerCallback(queryId) {
  try {
    await bot.answerCallbackQuery(queryId);
  } catch {
    // Ignore callback answer errors.
  }
}

function displayName(user) {
  if (!user) return "Admin";

  const fullName = [
    user.first_name,
    user.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || user.username || "Admin";
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function getAdmin(userId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("*")
    .eq("telegram_user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to get admin: ${error.message}`
    );
  }

  return data;
}

async function ensureOwnerAccount() {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("*")
    .eq("telegram_user_id", OWNER_ID)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Unable to check owner account: ${error.message}`
    );
  }

  if (data) {
    if (
      data.role !== "owner" ||
      data.is_active !== true
    ) {
      const { error: updateError } = await supabase
        .from("telegram_admins")
        .update({
          role: "owner",
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq(
          "telegram_user_id",
          OWNER_ID
        );

      if (updateError) {
        throw new Error(
          `Unable to repair owner account: ${updateError.message}`
        );
      }
    }

    return;
  }

  const passwordHash = hashPassword(
    OWNER_PASSWORD
  );

  const { error: insertError } = await supabase
    .from("telegram_admins")
    .insert({
      telegram_user_id: OWNER_ID,
      role: "owner",
      password_hash: passwordHash,
      is_active: true,
    });

  if (insertError) {
    throw new Error(
      `Unable to create owner account: ${insertError.message}`
    );
  }

  console.log("Owner account created.");
}

// ============================================================
// AUTH HELPERS
// ============================================================

function requireAuth(userId) {
  const session = getSession(userId);

  if (
    !session ||
    session.authenticated !== true
  ) {
    return null;
  }

  return session;
}

function requireOwner(userId) {
  const session = requireAuth(userId);

  if (!session) return null;

  if (session.role !== "owner") {
    return null;
  }

  return session;
}

async function sendLoginPrompt(chatId) {
  setSession(chatId, {
    authenticated: false,
    state: "awaiting_password",
  });

  await safeSend(
    chatId,
    "🔐 *PrepArena Admin Login*\n\nEnter your admin password:",
    {
      parse_mode: "Markdown",
    }
  );
}

// ============================================================
// MAIN ADMIN PANEL
// ============================================================

async function sendAdminPanel(chatId) {
  await safeSend(
    chatId,
    "🛡️ *PrepArena Admin Panel*\n\nChoose an action:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Create Test",
              callback_data: "create",
            },
            {
              text: "📋 Manage Tests",
              callback_data: "tests",
            },
          ],
          [
            {
              text: "📚 Subjects",
              callback_data: "subs",
            },
            {
              text: "🏆 Results",
              callback_data: "results",
            },
          ],
          [
            {
              text: "👥 Admins",
              callback_data: "admins",
            },
          ],
          [
            {
              text: "❓ Help",
              callback_data: "help",
            },
          ],
          [
            {
              text: "🚪 Logout",
              callback_data: "logout",
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// HELP
// ============================================================

async function sendHelp(chatId) {
  await safeSend(
    chatId,
    `❓ *PrepArena Admin Help*

*Create Test*
Create a new draft test and configure its details.

*Manage Tests*
View, edit and manage existing tests.

*Question Builder*
Add MCQ, Multiple Correct and Numerical questions.

*Subjects*
Add, rename or disable subjects.

*Admins*
Only the owner can manage admin accounts.

*Authentication*
Every new admin action session requires login.

*Answer Key*
Answer keys are intentionally handled after the test ends.

Use /cancel anytime to cancel the current operation.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "panel",
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// TEST LIST
// ============================================================

async function sendTestList(chatId) {
  const { data, error } = await supabase
    .from("tests")
    .select(
      "id,title,status,test_code,test_date,test_time,duration_minutes,total_questions,total_marks"
    )
    .order("created_at", {
      ascending: false,
    });

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load tests.\n\n${error.message}`
    );
    return;
  }

  if (!data || data.length === 0) {
    await safeSend(
      chatId,
      "📋 No tests found.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Create Test",
                callback_data: "create",
              },
            ],
            [
              {
                text: "⬅️ Back",
                callback_data: "panel",
              },
            ],
          ],
        },
      }
    );
    return;
  }

  const buttons = [];

  for (const test of data) {
    const status =
      test.status === "draft"
        ? "📝"
        : test.status === "published"
        ? "🟢"
        : "🔴";

    buttons.push([
      {
        text: `${status} ${test.title}`,
        callback_data: `tm_${test.id}`,
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "panel",
    },
  ]);

  await safeSend(
    chatId,
    "📋 *Manage Tests*\n\nSelect a test:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// TEST DETAIL
// ============================================================

async function sendTestDetail(
  chatId,
  testId
) {
  const { data: test, error } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .single();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { data: links } = await supabase
    .from("test_subjects")
    .select(
      "subject_id, subjects(name)"
    )
    .eq("test_id", testId);

  const subjectNames =
    (links || [])
      .map((x) => x.subjects?.name)
      .filter(Boolean);

  const subjectText =
    subjectNames.length > 0
      ? subjectNames.join(", ")
      : "None";

  const text =
    `📋 *${escapeMarkdown(test.title)}*\n\n` +
    `Code: \`${test.test_code || "-"}\`\n` +
    `Status: *${test.status}*\n` +
    `Date: ${test.test_date || "-"}\n` +
    `Time: ${test.test_time || "-"}\n` +
    `Duration: ${test.duration_minutes} min\n` +
    `Questions: ${test.total_questions}\n` +
    `Total Marks: ${test.total_marks}\n` +
    `Subjects: ${escapeMarkdown(subjectText)}\n\n` +
    `${test.description || ""}`;

  const rows = [];

  if (test.status === "draft") {
    rows.push([
      {
        text: "✏️ Edit Test",
        callback_data: `te_${testId}`,
      },
    ]);

    rows.push([
      {
        text: "❓ Questions",
        callback_data: `q_${testId}`,
      },
    ]);

    rows.push([
      {
        text: "📚 Test Subjects",
        callback_data: `ts_${testId}`,
      },
    ]);

    rows.push([
      {
        text: "🟢 Publish",
        callback_data: `pub_${testId}`,
      },
    ]);
  } else if (test.status === "published") {
    rows.push([
      {
        text: "❓ View Questions",
        callback_data: `q_${testId}`,
      },
    ]);

    rows.push([
      {
        text: "🔴 End Test",
        callback_data: `end_${testId}`,
      },
    ]);
  } else {
    rows.push([
      {
        text: "🔑 Answer Key",
        callback_data: `ak_${testId}`,
      },
    ]);

    rows.push([
      {
        text: "🏆 Results",
        callback_data: `tr_${testId}`,
      },
    ]);
  }

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: "tests",
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

// ============================================================
// CREATE TEST
// ============================================================

async function startCreateTest(chatId) {
  setSession(chatId, {
    authenticated: true,
    role: getSession(chatId).role,
    state: "create_title",
    data: {},
  });

  await safeSend(
    chatId,
    "➕ *Create Test*\n\nEnter the test title:",
    {
      parse_mode: "Markdown",
    }
  );
}

async function processCreateTest(
  chatId,
  messageText,
  session
) {
  const value = messageText.trim();

  if (!value) {
    await safeSend(
      chatId,
      "❌ Title cannot be empty.\n\nEnter the test title:"
    );
    return;
  }

  if (session.state === "create_title") {
    session.data.title = value;
    session.state = "create_description";

    await safeSend(
      chatId,
      "Enter test description.\n\nSend `-` if you don't want a description.",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_description") {
    session.data.description =
      value === "-" ? null : value;

    session.state = "create_date";

    await safeSend(
      chatId,
      "Enter test date in format:\n`YYYY-MM-DD`\n\nSend `-` for no date.",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_date") {
    if (value !== "-") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        await safeSend(
          chatId,
          "❌ Invalid date format.\nUse `YYYY-MM-DD`."
        );
        return;
      }

      session.data.test_date = value;
    } else {
      session.data.test_date = null;
    }

    session.state = "create_time";

    await safeSend(
      chatId,
      "Enter test time in format:\n`HH:MM`\n\nSend `-` for no time.",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_time") {
    if (value !== "-") {
      if (!/^\d{2}:\d{2}$/.test(value)) {
        await safeSend(
          chatId,
          "❌ Invalid time format.\nUse `HH:MM`."
        );
        return;
      }

      const [h, m] = value
        .split(":")
        .map(Number);

      if (
        h < 0 ||
        h > 23 ||
        m < 0 ||
        m > 59
      ) {
        await safeSend(
          chatId,
          "❌ Invalid time."
        );
        return;
      }

      session.data.test_time = value;
    } else {
      session.data.test_time = null;
    }

    session.state = "create_duration";

    await safeSend(
      chatId,
      "Enter duration in minutes.\nExample: `180`",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_duration") {
    const duration = Number(value);

    if (
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      await safeSend(
        chatId,
        "❌ Duration must be a positive whole number."
      );
      return;
    }

    session.data.duration_minutes = duration;
    session.state = "create_marks";

    await safeSend(
      chatId,
      "Enter marks per question.\nExample: `4`",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_marks") {
    const marks = Number(value);

    if (!Number.isFinite(marks) || marks <= 0) {
      await safeSend(
        chatId,
        "❌ Marks must be greater than 0."
      );
      return;
    }

    session.data.marks_per_question = marks;
    session.state = "create_negative";

    await safeSend(
      chatId,
      "Enter negative marking value.\nExample: `1`\n\nSend `0` for no negative marking.",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_negative") {
    const negative = Number(value);

    if (
      !Number.isFinite(negative) ||
      negative < 0
    ) {
      await safeSend(
        chatId,
        "❌ Negative marking cannot be below 0."
      );
      return;
    }

    session.data.negative_marking_value =
      negative;

    session.state = "create_instructions";

    await safeSend(
      chatId,
      "Enter test instructions.\n\nSend `-` if there are no instructions.",
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  if (session.state === "create_instructions") {
    session.data.instructions =
      value === "-" ? null : value;

    const d = session.data;

    const code =
      "PA-" +
      Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();

    const { data, error } = await supabase
      .from("tests")
      .insert({
        title: d.title,
        description: d.description,
        test_code: code,
        status: "draft",
        test_date: d.test_date,
        test_time: d.test_time,
        duration_minutes: d.duration_minutes,
        total_questions: 0,
        total_marks: 0,
        marks_per_question:
          d.marks_per_question,
        negative_marking_enabled:
          d.negative_marking_value > 0,
        negative_marking_value:
          d.negative_marking_value,
        instructions: d.instructions,
      })
      .select()
      .single();

    if (error) {
      await safeSend(
        chatId,
        `❌ Failed to create test.\n\n${error.message}`
      );
      return;
    }

    session.state = null;
    session.data = {};

    await safeSend(
      chatId,
      `✅ *Test Created!*

Title: ${escapeMarkdown(data.title)}
Code: \`${data.test_code}\`
Status: Draft

Now add subjects and questions.`,
      {
        parse_mode: "Markdown",
      }
    );

    await sendTestDetail(
      chatId,
      data.id
    );
  }
}

// ============================================================
// EDIT TEST
// ============================================================

async function showEditTestMenu(
  chatId,
  testId
) {
  const { data: test, error } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .single();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 Only draft tests can be edited."
    );
    return;
  }

  await safeSend(
    chatId,
    `✏️ *Edit Test*\n\n${escapeMarkdown(
      test.title
    )}\n\nChoose what to edit:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Title",
              callback_data: `et_${testId}_title`,
            },
          ],
          [
            {
              text: "Description",
              callback_data: `et_${testId}_desc`,
            },
          ],
          [
            {
              text: "Date",
              callback_data: `et_${testId}_date`,
            },
            {
              text: "Time",
              callback_data: `et_${testId}_time`,
            },
          ],
          [
            {
              text: "Duration",
              callback_data: `et_${testId}_dur`,
            },
          ],
          [
            {
              text: "Marks",
              callback_data: `et_${testId}_marks`,
            },
          ],
          [
            {
              text: "Negative",
              callback_data: `et_${testId}_neg`,
            },
          ],
          [
            {
              text: "Instructions",
              callback_data: `et_${testId}_inst`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: `tm_${testId}`,
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// SUBJECTS
// ============================================================

async function sendSubjectsMenu(chatId) {
  const { data, error } = await supabase
    .from("subjects")
    .select("*")
    .order("name");

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load subjects.\n\n${error.message}`
    );
    return;
  }

  const rows = [];

  for (const subject of data || []) {
    rows.push([
      {
        text:
          (subject.is_active ? "🟢 " : "⚪ ") +
          subject.name,
        callback_data: `sub_${subject.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: "➕ Add Subject",
      callback_data: "subadd",
    },
  ]);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: "panel",
    },
  ]);

  await safeSend(
    chatId,
    "📚 *Subjects*\n\n🟢 Active\n⚪ Disabled",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

async function sendSubjectDetail(
  chatId,
  subjectId
) {
  const { data: subject, error } = await supabase
    .from("subjects")
    .select("*")
    .eq("id", subjectId)
    .single();

  if (error || !subject) {
    await safeSend(
      chatId,
      "❌ Subject not found."
    );
    return;
  }

  await safeSend(
    chatId,
    `📚 *${escapeMarkdown(
      subject.name
    )}*\n\nStatus: ${
      subject.is_active
        ? "🟢 Active"
        : "⚪ Disabled"
    }`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✏️ Rename",
              callback_data: `sr_${subjectId}`,
            },
          ],
          [
            {
              text: subject.is_active
                ? "⚪ Disable"
                : "🟢 Enable",
              callback_data: `st_${subjectId}`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: "subs",
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// ADD SUBJECT
// ============================================================

async function startAddSubject(chatId) {
  const session = getSession(chatId);

  setSession(chatId, {
    ...session,
    state: "subject_add",
  });

  await safeSend(
    chatId,
    "➕ Enter the new subject name:"
  );
}

// ============================================================
// TEST SUBJECTS
// ============================================================

async function sendTestSubjects(
  chatId,
  testId
) {
  const { data: subjects, error } = await supabase
    .from("subjects")
    .select("*")
    .eq("is_active", true)
    .order("name");

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load subjects.\n\n${error.message}`
    );
    return;
  }

  const { data: selected } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq("test_id", testId);

  const selectedIds = new Set(
    (selected || []).map(
      (x) => x.subject_id
    )
  );

  const rows = [];

  for (const subject of subjects || []) {
    rows.push([
      {
        text:
          (selectedIds.has(subject.id)
            ? "☑️ "
            : "⬜ ") + subject.name,
        callback_data: `tx_${testId}_${subject.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: "✅ Done",
      callback_data: `tm_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    "📚 *Select Test Subjects*\n\nTap subjects to toggle them.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

// ============================================================
// QUESTION BUILDER
// ============================================================

async function sendQuestionMenu(
  chatId,
  testId
) {
  const { data: test, error } = await supabase
    .from("tests")
    .select("id,title,status,total_questions")
    .eq("id", testId)
    .single();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { count } = await supabase
    .from("questions")
    .select("*", {
      count: "exact",
      head: true,
    })
    .eq("test_id", testId);

  const total = count || 0;

  await safeSend(
    chatId,
    `❓ *Question Builder*

Test: ${escapeMarkdown(test.title)}
Questions: *${total}*
Status: *${test.status}*

Choose an action:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Question",
              callback_data: `qa_${testId}`,
            },
          ],
          [
            {
              text: "📖 View Questions",
              callback_data: `qv_${testId}_0`,
            },
          ],
          [
            {
              text: "✏️ Edit Question",
              callback_data: `qe_${testId}_0`,
            },
          ],
          [
            {
              text: "🗑️ Delete Question",
              callback_data: `qd_${testId}_0`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: `tm_${testId}`,
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// ADD QUESTION
// ============================================================

async function startAddQuestion(
  chatId,
  testId
) {
  const session = getSession(chatId);

  const { data: test, error } = await supabase
    .from("tests")
    .select("id,status,total_questions")
    .eq("id", testId)
    .single();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 Questions can only be added to draft tests."
    );
    return;
  }

  const nextNumber =
    (test.total_questions || 0) + 1;

  setSession(chatId, {
    ...session,
    state: "question_type",
    data: {
      testId,
      questionNumber: nextNumber,
      options: [],
    },
  });

  await safeSend(
    chatId,
    `➕ *Add Question #${nextNumber}*

Select question type:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 MCQ",
              callback_data: `qt_m_${testId}`,
            },
          ],
          [
            {
              text: "☑️ Multiple Correct",
              callback_data: `qt_c_${testId}`,
            },
          ],
          [
            {
              text: "🔢 Numerical",
              callback_data: `qt_n_${testId}`,
            },
          ],
          [
            {
              text: "❌ Cancel",
              callback_data: "cancel",
            },
          ],
        ],
      },
    }
  );
}

async function continueQuestionText(
  chatId,
  session
) {
  session.state = "question_text";

  await safeSend(
    chatId,
    `📝 Enter question text for Question #${session.data.questionNumber}:`
  );
}

async function startQuestionAfterType(
  chatId,
  type,
  testId
) {
  const session = getSession(chatId);

  if (
    !session ||
    !session.data ||
    session.data.testId !== testId
  ) {
    await safeSend(
      chatId,
      "❌ Question session expired. Start again."
    );
    return;
  }

  session.data.questionType = type;

  await continueQuestionText(
    chatId,
    session
  );
}

async function processQuestionInput(
  chatId,
  text,
  session
) {
  const value = text.trim();

  if (
    session.state === "question_text"
  ) {
    if (!value) {
      await safeSend(
        chatId,
        "❌ Question text cannot be empty."
      );
      return;
    }

    session.data.questionText = value;

    if (
      session.data.questionType === "numerical"
    ) {
      session.state = "numerical_answer";

      await safeSend(
        chatId,
        "🔢 Enter the numerical answer:"
      );
    } else {
      session.data.options = [];
      session.state = "option_1";

      await safeSend(
        chatId,
        "A️⃣ Enter Option A:"
      );
    }

    return;
  }

  if (
    session.state === "option_1" ||
    session.state === "option_2" ||
    session.state === "option_3" ||
    session.state === "option_4"
  ) {
    if (!value) {
      await safeSend(
        chatId,
        "❌ Option cannot be empty."
      );
      return;
    }

    const index =
      Number(
        session.state.split("_")[1]
      ) - 1;

    session.data.options[index] = value;

    if (index === 0) {
      session.state = "option_2";
      await safeSend(
        chatId,
        "B️⃣ Enter Option B:"
      );
    } else if (index === 1) {
      session.state = "option_3";
      await safeSend(
        chatId,
        "C️⃣ Enter Option C:"
      );
    } else if (index === 2) {
      session.state = "option_4";
      await safeSend(
        chatId,
        "D️⃣ Enter Option D:"
      );
    } else {
      session.state = "question_marks";

      await safeSend(
        chatId,
        "💯 Enter marks for this question:"
      );
    }

    return;
  }

  if (
    session.state === "numerical_answer"
  ) {
    if (!value) {
      await safeSend(
        chatId,
        "❌ Numerical answer cannot be empty."
      );
      return;
    }

    session.data.numericAnswer = value;
    session.state = "question_marks";

    await safeSend(
      chatId,
      "💯 Enter marks for this question:"
    );

    return;
  }

  if (
    session.state === "question_marks"
  ) {
    const marks = Number(value);

    if (!Number.isFinite(marks) || marks <= 0) {
      await safeSend(
        chatId,
        "❌ Marks must be greater than 0."
      );
      return;
    }

    session.data.marks = marks;
    session.state = "question_negative";

    await safeSend(
      chatId,
      "➖ Enter negative marks.\n\nUse `0` for no negative marking.",
      {
        parse_mode: "Markdown",
      }
    );

    return;
  }

  if (
    session.state === "question_negative"
  ) {
    const negative = Number(value);

    if (
      !Number.isFinite(negative) ||
      negative < 0
    ) {
      await safeSend(
        chatId,
        "❌ Negative marks cannot be below 0."
      );
      return;
    }

    session.data.negativeMarks = negative;

    await saveQuestion(
      chatId,
      session
    );
  }
}

// ============================================================
// SAVE QUESTION
// ============================================================

async function saveQuestion(
  chatId,
  session
) {
  const d = session.data;

  const { data: test, error: testError } =
    await supabase
      .from("tests")
      .select("id,status")
      .eq("id", d.testId)
      .single();

  if (
    testError ||
    !test ||
    test.status !== "draft"
  ) {
    await safeSend(
      chatId,
      "❌ Test is no longer editable."
    );
    return;
  }

  const { data: question, error } =
    await supabase
      .from("questions")
      .insert({
        test_id: d.testId,
        question_number: d.questionNumber,
        question_text: d.questionText,
        question_type:
          d.questionType,
        marks: d.marks,
        negative_marks:
          d.negativeMarks,
      })
      .select()
      .single();

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to save question.\n\n${error.message}`
    );
    return;
  }

  if (
    d.questionType === "mcq" ||
    d.questionType === "multiple_correct"
  ) {
    const labels = ["A", "B", "C", "D"];

    const optionRows =
      d.options.map(
        (optionText, index) => ({
          question_id: question.id,
          option_label: labels[index],
          option_text: optionText,
          option_order: index + 1,
        })
      );

    const { error: optionError } =
      await supabase
        .from("question_options")
        .insert(optionRows);

    if (optionError) {
      await supabase
        .from("questions")
        .delete()
        .eq("id", question.id);

      await safeSend(
        chatId,
        `❌ Failed to save options.\n\n${optionError.message}`
      );
      return;
    }
  }

  await recalculateTestTotals(
    d.testId
  );

  setSession(chatId, {
    authenticated: true,
    role: session.role,
    state: null,
    data: {},
  });

  await safeSend(
    chatId,
    `✅ *Question #${d.questionNumber} Saved!*

Type: ${formatQuestionType(
      d.questionType
    )}
Marks: ${d.marks}
Negative: ${d.negativeMarks}

Correct answer has NOT been added.
It will be handled later through Answer Key.`,
    {
      parse_mode: "Markdown",
    }
  );

  await sendQuestionMenu(
    chatId,
    d.testId
  );
}

// ============================================================
// VIEW QUESTIONS
// ============================================================

async function viewQuestions(
  chatId,
  testId,
  page = 0
) {
  const PAGE_SIZE = 5;
  const offset = page * PAGE_SIZE;

  const { data, error, count } =
    await supabase
      .from("questions")
      .select("*", {
        count: "exact",
      })
      .eq("test_id", testId)
      .order("question_number", {
        ascending: true,
      })
      .range(
        offset,
        offset + PAGE_SIZE - 1
      );

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load questions.\n\n${error.message}`
    );
    return;
  }

  if (!data || data.length === 0) {
    await safeSend(
      chatId,
      "📖 No questions found.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add Question",
                callback_data: `qa_${testId}`,
              },
            ],
            [
              {
                text: "⬅️ Back",
                callback_data: `q_${testId}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  let text = `📖 *Questions*\n\n`;

  for (const q of data) {
    text +=
      `*Q${q.question_number}* ` +
      `(${formatQuestionType(
        q.question_type
      )})\n` +
      `${truncate(q.question_text, 150)}\n` +
      `Marks: ${q.marks} | Negative: ${q.negative_marks}\n\n`;
  }

  const rows = [];

  const totalPages = Math.ceil(
    (count || 0) / PAGE_SIZE
  );

  const nav = [];

  if (page > 0) {
    nav.push({
      text: "⬅️",
      callback_data: `qv_${testId}_${page - 1}`,
    });
  }

  nav.push({
    text: `${page + 1}/${totalPages}`,
    callback_data: "noop",
  });

  if (page + 1 < totalPages) {
    nav.push({
      text: "➡️",
      callback_data: `qv_${testId}_${page + 1}`,
    });
  }

  rows.push(nav);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: `q_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

// ============================================================
// EDIT QUESTION LIST
// ============================================================

async function editQuestionList(
  chatId,
  testId,
  page = 0
) {
  const { data: test } = await supabase
    .from("tests")
    .select("status")
    .eq("id", testId)
    .single();

  if (!test || test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 Questions can only be edited while the test is draft."
    );
    return;
  }

  const PAGE_SIZE = 8;
  const offset = page * PAGE_SIZE;

  const { data, error, count } =
    await supabase
      .from("questions")
      .select(
        "id,question_number,question_text,question_type",
        {
          count: "exact",
        }
      )
      .eq("test_id", testId)
      .order("question_number")
      .range(
        offset,
        offset + PAGE_SIZE - 1
      );

  if (error) {
    await safeSend(
      chatId,
      `❌ ${error.message}`
    );
    return;
  }

  if (!data || data.length === 0) {
    await safeSend(
      chatId,
      "❌ No questions to edit.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Back",
                callback_data: `q_${testId}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  const rows = data.map((q) => [
    {
      text: `Q${q.question_number} — ${truncate(
        q.question_text,
        35
      )}`,
      callback_data: `qee_${q.id}`,
    },
  ]);

  const totalPages = Math.ceil(
    (count || 0) / PAGE_SIZE
  );

  const nav = [];

  if (page > 0) {
    nav.push({
      text: "⬅️",
      callback_data: `qe_${testId}_${page - 1}`,
    });
  }

  nav.push({
    text: `${page + 1}/${totalPages}`,
    callback_data: "noop",
  });

  if (page + 1 < totalPages) {
    nav.push({
      text: "➡️",
      callback_data: `qe_${testId}_${page + 1}`,
    });
  }

  rows.push(nav);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: `q_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    "✏️ *Select a question to edit:*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

// ============================================================
// EDIT QUESTION
// ============================================================

async function showQuestionEdit(
  chatId,
  questionId
) {
  const { data: q, error } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .single();

  if (error || !q) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const { data: test } = await supabase
    .from("tests")
    .select("status")
    .eq("id", q.test_id)
    .single();

  if (!test || test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 This question cannot be edited."
    );
    return;
  }

  const { data: answerKey } =
    await supabase
      .from("answer_keys")
      .select("id")
      .eq("question_id", questionId)
      .maybeSingle();

  if (answerKey) {
    await safeSend(
      chatId,
      "🔒 This question already has an answer key and cannot be edited."
    );
    return;
  }

  await safeSend(
    chatId,
    `✏️ *Edit Question #${q.question_number}*\n\n${truncate(
      q.question_text,
      500
    )}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📝 Question Text",
              callback_data: `qet_${questionId}`,
            },
          ],
          [
            {
              text: "🔢 Change Type",
              callback_data: `qec_${questionId}`,
            },
          ],
          [
            {
              text: "💯 Marks",
              callback_data: `qem_${questionId}`,
            },
          ],
          [
            {
              text: "➖ Negative",
              callback_data: `qen_${questionId}`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: `q_${q.test_id}`,
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// DELETE QUESTION
// ============================================================

async function deleteQuestionList(
  chatId,
  testId,
  page = 0
) {
  const { data: test } = await supabase
    .from("tests")
    .select("status")
    .eq("id", testId)
    .single();

  if (!test || test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 Questions can only be deleted from draft tests."
    );
    return;
  }

  const PAGE_SIZE = 8;
  const offset = page * PAGE_SIZE;

  const { data, error, count } =
    await supabase
      .from("questions")
      .select(
        "id,question_number,question_text",
        {
          count: "exact",
        }
      )
      .eq("test_id", testId)
      .order("question_number")
      .range(
        offset,
        offset + PAGE_SIZE - 1
      );

  if (error) {
    await safeSend(
      chatId,
      `❌ ${error.message}`
    );
    return;
  }

  if (!data || data.length === 0) {
    await safeSend(
      chatId,
      "❌ No questions to delete."
    );
    return;
  }

  const rows = data.map((q) => [
    {
      text: `🗑️ Q${q.question_number} — ${truncate(
        q.question_text,
        35
      )}`,
      callback_data: `qdx_${q.id}`,
    },
  ]);

  const totalPages = Math.ceil(
    (count || 0) / PAGE_SIZE
  );

  const nav = [];

  if (page > 0) {
    nav.push({
      text: "⬅️",
      callback_data: `qd_${testId}_${page - 1}`,
    });
  }

  nav.push({
    text: `${page + 1}/${totalPages}`,
    callback_data: "noop",
  });

  if (page + 1 < totalPages) {
    nav.push({
      text: "➡️",
      callback_data: `qd_${testId}_${page + 1}`,
    });
  }

  rows.push(nav);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: `q_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    "🗑️ *Select a question to delete:*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

async function confirmDeleteQuestion(
  chatId,
  questionId
) {
  const { data: q } = await supabase
    .from("questions")
    .select(
      "id,test_id,question_number,question_text"
    )
    .eq("id", questionId)
    .single();

  if (!q) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  await safeSend(
    chatId,
    `⚠️ *Delete Question #${q.question_number}?*

${truncate(q.question_text, 400)}

This will also delete its options.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Yes, Delete",
              callback_data: `qdy_${questionId}`,
            },
            {
              text: "↩️ Cancel",
              callback_data: `q_${q.test_id}`,
            },
          ],
        ],
      },
    }
  );
}

async function deleteQuestion(
  chatId,
  questionId
) {
  const { data: q, error } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .single();

  if (error || !q) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const testId = q.test_id;

  const { data: test } = await supabase
    .from("tests")
    .select("status")
    .eq("id", testId)
    .single();

  if (!test || test.status !== "draft") {
    await safeSend(
      chatId,
      "🔒 Test is not editable."
    );
    return;
  }

  const { error: deleteError } =
    await supabase
      .from("questions")
      .delete()
      .eq("id", questionId);

  if (deleteError) {
    await safeSend(
      chatId,
      `❌ Delete failed.\n\n${deleteError.message}`
    );
    return;
  }

  // Renumber safely to avoid unique(test_id, question_number)
  const { data: remaining, error } =
    await supabase
      .from("questions")
      .select("id")
      .eq("test_id", testId)
      .order("question_number");

  if (error) {
    await safeSend(
      chatId,
      `⚠️ Question deleted, but renumbering failed.\n\n${error.message}`
    );
    return;
  }

  const OFFSET = 1000000;

  for (let i = 0; i < remaining.length; i++) {
    await supabase
      .from("questions")
      .update({
        question_number:
          OFFSET + i + 1,
      })
      .eq("id", remaining[i].id);
  }

  for (let i = 0; i < remaining.length; i++) {
    await supabase
      .from("questions")
      .update({
        question_number: i + 1,
      })
      .eq("id", remaining[i].id);
  }

  await recalculateTestTotals(
    testId
  );

  await safeSend(
    chatId,
    "✅ Question deleted and remaining questions renumbered."
  );

  await sendQuestionMenu(
    chatId,
    testId
  );
}

// ============================================================
// RECALCULATE TEST TOTALS
// ============================================================

async function recalculateTestTotals(
  testId
) {
  const { data: questions, error } =
    await supabase
      .from("questions")
      .select("marks")
      .eq("test_id", testId);

  if (error) {
    console.error(
      "Recalculate totals error:",
      error.message
    );
    return;
  }

  const totalQuestions =
    questions?.length || 0;

  const totalMarks =
    (questions || []).reduce(
      (sum, q) =>
        sum + Number(q.marks || 0),
      0
    );

  await supabase
    .from("tests")
    .update({
      total_questions:
        totalQuestions,
      total_marks: totalMarks,
      updated_at:
        new Date().toISOString(),
    })
    .eq("id", testId);
}

// ============================================================
// ADMIN MANAGEMENT
// ============================================================

async function sendAdminsMenu(chatId) {
  const session = requireOwner(chatId);

  if (!session) {
    await safeSend(
      chatId,
      "🔒 Owner access required."
    );
    return;
  }

  const { data, error } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id,role,is_active,created_at"
    )
    .order("created_at");

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load admins.\n\n${error.message}`
    );
    return;
  }

  let text = "👥 *Admin Management*\n\n";

  for (const admin of data || []) {
    text +=
      `${admin.role === "owner" ? "👑" : "👤"} ` +
      `\`${admin.telegram_user_id}\`` +
      ` — ${admin.role}` +
      ` — ${admin.is_active ? "active" : "disabled"}\n`;
  }

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Admin",
              callback_data: "adda",
            },
          ],
          [
            {
              text: "🔧 Manage Admin",
              callback_data: "ma",
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: "panel",
            },
          ],
        ],
      },
    }
  );
}

async function startAddAdmin(chatId) {
  const session = requireOwner(chatId);

  if (!session) {
    await safeSend(
      chatId,
      "🔒 Owner access required."
    );
    return;
  }

  setSession(chatId, {
    ...session,
    state: "admin_add_id",
    data: {},
  });

  await safeSend(
    chatId,
    "👤 Enter the Telegram numeric user ID of the new admin:"
  );
}

// ============================================================
// RESULTS
// ============================================================

async function sendResultsMenu(chatId) {
  const { data, error } = await supabase
    .from("tests")
    .select(
      "id,title,status,total_questions,total_marks"
    )
    .eq("status", "ended")
    .order("created_at", {
      ascending: false,
    });

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load results.\n\n${error.message}`
    );
    return;
  }

  if (!data || data.length === 0) {
    await safeSend(
      chatId,
      "🏆 No ended tests yet.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Back",
                callback_data: "panel",
              },
            ],
          ],
        },
      }
    );
    return;
  }

  const rows = data.map((test) => [
    {
      text: `🏆 ${test.title}`,
      callback_data: `tr_${test.id}`,
    },
  ]);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data: "panel",
    },
  ]);

  await safeSend(
    chatId,
    "🏆 *Results*\n\nSelect an ended test:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows,
      },
    }
  );
}

async function sendTestResults(
  chatId,
  testId
) {
  const { data: test } = await supabase
    .from("tests")
    .select("title,total_marks")
    .eq("id", testId)
    .single();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { data: results, error } =
    await supabase
      .from("results")
      .select(
        "telegram_user_id,score,total_marks,correct_count,wrong_count,unattempted_count,rank"
      )
      .eq("test_id", testId)
      .order("rank", {
        ascending: true,
      })
      .limit(50);

  if (error) {
    await safeSend(
      chatId,
      `❌ Unable to load results.\n\n${error.message}`
    );
    return;
  }

  if (!results || results.length === 0) {
    await safeSend(
      chatId,
      `🏆 *${escapeMarkdown(
        test.title
      )}*\n\nNo results available yet.`,
      {
        parse_mode: "Markdown",
      }
    );
    return;
  }

  let text =
    `🏆 *${escapeMarkdown(
      test.title
    )}*\n\n`;

  results.forEach((r, index) => {
    text +=
      `${r.rank || index + 1}. ` +
      `\`${r.telegram_user_id}\` — ` +
      `${r.score}/${r.total_marks}\n`;
  });

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: "results",
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// PUBLISH / END
// ============================================================

async function publishTest(
  chatId,
  testId
) {
  const { data: test } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .single();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (test.status !== "draft") {
    await safeSend(
      chatId,
      "❌ Only draft tests can be published."
    );
    return;
  }

  if (test.total_questions <= 0) {
    await safeSend(
      chatId,
      "❌ Add at least one question before publishing."
    );
    return;
  }

  const { data: subjects } =
    await supabase
      .from("test_subjects")
      .select("subject_id")
      .eq("test_id", testId);

  if (!subjects || subjects.length === 0) {
    await safeSend(
      chatId,
      "❌ Add at least one subject before publishing."
    );
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "published",
      updated_at:
        new Date().toISOString(),
    })
    .eq("id", testId);

  if (error) {
    await safeSend(
      chatId,
      `❌ Publish failed.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    "🟢 Test published successfully!"
  );

  await sendTestDetail(
    chatId,
    testId
  );
}

async function endTest(
  chatId,
  testId
) {
  const { data: test } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .single();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (test.status !== "published") {
    await safeSend(
      chatId,
      "❌ Only published tests can be ended."
    );
    return;
  }

  const { error } = await supabase
    .from("tests")
    .update({
      status: "ended",
      updated_at:
        new Date().toISOString(),
    })
    .eq("id", testId);

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to end test.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    "🔴 Test ended successfully.\n\nAnswer Key can now be added manually."
  );

  await sendTestDetail(
    chatId,
    testId
  );
}

// ============================================================
// ANSWER KEY PLACEHOLDER
// ============================================================

async function sendAnswerKeyMenu(
  chatId,
  testId
) {
  await safeSend(
    chatId,
    "🔑 *Answer Key Upload*\n\nThis section is reserved for the manual post-test answer key flow.\n\nQuestion Builder does not store correct answers.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data: `tm_${testId}`,
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// TEXT INPUT HANDLER
// ============================================================

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text.trim();

    // Commands are handled separately below.
    if (text.startsWith("/")) {
      return;
    }

    const session = getSession(userId);

    if (
      session &&
      session.state === "awaiting_password"
    ) {
      const admin = await getAdmin(userId);

      if (!admin || admin.is_active !== true) {
        await safeSend(
          chatId,
          "❌ You are not authorized to use this bot."
        );

        clearSession(userId);
        return;
      }

      if (
        verifyPassword(
          text,
          admin.password_hash
        )
      ) {
        setSession(userId, {
          authenticated: true,
          role: admin.role,
          state: null,
          data: {},
        });

        await safeSend(
          chatId,
          "✅ Login successful."
        );

        await sendAdminPanel(chatId);
      } else {
        await safeSend(
          chatId,
          "❌ Incorrect password.\n\nTry again or use /cancel."
        );
      }

      return;
    }

    if (!session || session.authenticated !== true) {
      await safeSend(
        chatId,
        "🔐 Please use /admin to login."
      );
      return;
    }

    // --------------------------------------------------------
    // CREATE TEST INPUT
    // --------------------------------------------------------

    if (
      session.state &&
      session.state.startsWith("create_")
    ) {
      await processCreateTest(
        chatId,
        text,
        session
      );
      return;
    }

    // --------------------------------------------------------
    // QUESTION INPUT
    // --------------------------------------------------------

    if (
      session.state === "question_text" ||
      session.state === "option_1" ||
      session.state === "option_2" ||
      session.state === "option_3" ||
      session.state === "option_4" ||
      session.state === "numerical_answer" ||
      session.state === "question_marks" ||
      session.state === "question_negative"
    ) {
      await processQuestionInput(
        chatId,
        text,
        session
      );
      return;
    }

    // --------------------------------------------------------
    // SUBJECT INPUT
    // --------------------------------------------------------

    if (
      session.state === "subject_add"
    ) {
      if (!text) {
        await safeSend(
          chatId,
          "❌ Subject name cannot be empty."
        );
        return;
      }

      const { error } = await supabase
        .from("subjects")
        .insert({
          name: text,
          is_active: true,
        });

      if (error) {
        if (
          error.code === "23505"
        ) {
          await safeSend(
            chatId,
            "❌ This subject already exists."
          );
        } else {
          await safeSend(
            chatId,
            `❌ Failed to add subject.\n\n${error.message}`
          );
        }

        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        `✅ Subject "${text}" added.`
      );

      await sendSubjectsMenu(
        chatId
      );

      return;
    }

    if (
      session.state === "subject_rename"
    ) {
      const subjectId =
        session.data.subjectId;

      const { error } = await supabase
        .from("subjects")
        .update({
          name: text,
        })
        .eq("id", subjectId);

      if (error) {
        if (
          error.code === "23505"
        ) {
          await safeSend(
            chatId,
            "❌ A subject with this name already exists."
          );
        } else {
          await safeSend(
            chatId,
            `❌ Rename failed.\n\n${error.message}`
          );
        }

        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Subject renamed successfully."
      );

      await sendSubjectsMenu(
        chatId
      );

      return;
    }

    // --------------------------------------------------------
    // TEST EDIT INPUT
    // --------------------------------------------------------

    if (
      session.state &&
      session.state.startsWith("edit_test_")
    ) {
      const parts =
        session.state.split("_");

      const field = parts[2];
      const testId =
        session.data.testId;

      let update = {};

      if (field === "title") {
        if (!text) {
          await safeSend(
            chatId,
            "❌ Title cannot be empty."
          );
          return;
        }

        update.title = text;
      }

      if (field === "desc") {
        update.description =
          text === "-" ? null : text;
      }

      if (field === "date") {
        if (
          text !== "-" &&
          !/^\d{4}-\d{2}-\d{2}$/.test(text)
        ) {
          await safeSend(
            chatId,
            "❌ Use YYYY-MM-DD."
          );
          return;
        }

        update.test_date =
          text === "-" ? null : text;
      }

      if (field === "time") {
        if (
          text !== "-" &&
          !/^\d{2}:\d{2}$/.test(text)
        ) {
          await safeSend(
            chatId,
            "❌ Use HH:MM."
          );
          return;
        }

        update.test_time =
          text === "-" ? null : text;
      }

      if (field === "dur") {
        const n = Number(text);

        if (
          !Number.isInteger(n) ||
          n <= 0
        ) {
          await safeSend(
            chatId,
            "❌ Duration must be a positive whole number."
          );
          return;
        }

        update.duration_minutes = n;
      }

      if (field === "marks") {
        const n = Number(text);

        if (!Number.isFinite(n) || n <= 0) {
          await safeSend(
            chatId,
            "❌ Marks must be greater than 0."
          );
          return;
        }

        update.marks_per_question = n;
      }

      if (field === "neg") {
        const n = Number(text);

        if (
          !Number.isFinite(n) ||
          n < 0
        ) {
          await safeSend(
            chatId,
            "❌ Negative marking cannot be below 0."
          );
          return;
        }

        update.negative_marking_value =
          n;

        update.negative_marking_enabled =
          n > 0;
      }

      if (field === "inst") {
        update.instructions =
          text === "-" ? null : text;
      }

      const { error } = await supabase
        .from("tests")
        .update({
          ...update,
          updated_at:
            new Date().toISOString(),
        })
        .eq("id", testId)
        .eq("status", "draft");

      if (error) {
        await safeSend(
          chatId,
          `❌ Update failed.\n\n${error.message}`
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Test updated successfully."
      );

      await sendTestDetail(
        chatId,
        testId
      );

      return;
    }

    // --------------------------------------------------------
    // ADMIN ADD INPUT
    // --------------------------------------------------------

    if (
      session.state === "admin_add_id"
    ) {
      const newId = Number(text);

      if (
        !Number.isSafeInteger(newId) ||
        newId <= 0
      ) {
        await safeSend(
          chatId,
          "❌ Enter a valid Telegram numeric user ID."
        );
        return;
      }

      if (newId === OWNER_ID) {
        await safeSend(
          chatId,
          "❌ Owner account cannot be added as a normal admin."
        );
        return;
      }

      const passwordHash =
        hashPassword(
          crypto.randomBytes(18).toString(
            "base64url"
          )
        );

      setSession(userId, {
        ...session,
        state: "admin_add_password",
        data: {
          newId,
          passwordHash,
        },
      });

      await safeSend(
        chatId,
        "🔐 Enter the new admin's password:"
      );

      return;
    }

    if (
      session.state ===
      "admin_add_password"
    ) {
      if (text.length < 6) {
        await safeSend(
          chatId,
          "❌ Password should be at least 6 characters."
        );
        return;
      }

      const newId =
        session.data.newId;

      const passwordHash =
        hashPassword(text);

      const { error } = await supabase
        .from("telegram_admins")
        .upsert(
          {
            telegram_user_id: newId,
            role: "admin",
            password_hash: passwordHash,
            is_active: true,
            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              "telegram_user_id",
          }
        );

      if (error) {
        await safeSend(
          chatId,
          `❌ Failed to add admin.\n\n${error.message}`
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        `✅ Admin added successfully.\n\nTelegram ID: \`${newId}\``,
        {
          parse_mode: "Markdown",
        }
      );

      await sendAdminsMenu(
        chatId
      );

      return;
    }

    // --------------------------------------------------------
    // ADMIN MANAGEMENT INPUT
    // --------------------------------------------------------

    if (
      session.state === "admin_manage_id"
    ) {
      const targetId = Number(text);

      if (
        !Number.isSafeInteger(targetId) ||
        targetId <= 0
      ) {
        await safeSend(
          chatId,
          "❌ Invalid Telegram ID."
        );
        return;
      }

      if (targetId === OWNER_ID) {
        await safeSend(
          chatId,
          "❌ Owner account cannot be modified here."
        );
        return;
      }

      const target =
        await getAdmin(targetId);

      if (!target) {
        await safeSend(
          chatId,
          "❌ Admin not found."
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        `👤 Admin: \`${targetId}\`\n\nStatus: ${
          target.is_active
            ? "Active"
            : "Disabled"
        }`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: target.is_active
                    ? "⚪ Disable"
                    : "🟢 Enable",
                  callback_data: `ad_${targetId}`,
                },
              ],
              [
                {
                  text: "🔐 Change Password",
                  callback_data: `ap_${targetId}`,
                },
              ],
              [
                {
                  text: "🗑️ Remove Admin",
                  callback_data: `ar_${targetId}`,
                },
              ],
              [
                {
                  text: "⬅️ Back",
                  callback_data: "admins",
                },
              ],
            ],
          },
        }
      );

      return;
    }

    if (
      session.state ===
      "admin_change_password"
    ) {
      const targetId =
        session.data.targetId;

      if (text.length < 6) {
        await safeSend(
          chatId,
          "❌ Password should be at least 6 characters."
        );
        return;
      }

      const { error } = await supabase
        .from("telegram_admins")
        .update({
          password_hash:
            hashPassword(text),
          updated_at:
            new Date().toISOString(),
        })
        .eq(
          "telegram_user_id",
          targetId
        )
        .eq("role", "admin");

      if (error) {
        await safeSend(
          chatId,
          `❌ Password update failed.\n\n${error.message}`
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Admin password changed successfully."
      );

      await sendAdminsMenu(
        chatId
      );

      return;
    }

    // --------------------------------------------------------
    // QUESTION EDIT INPUT
    // --------------------------------------------------------

    if (
      session.state ===
      "question_edit_text"
    ) {
      const questionId =
        session.data.questionId;

      if (!text) {
        await safeSend(
          chatId,
          "❌ Question text cannot be empty."
        );
        return;
      }

      const { error } = await supabase
        .from("questions")
        .update({
          question_text: text,
        })
        .eq("id", questionId);

      if (error) {
        await safeSend(
          chatId,
          `❌ Update failed.\n\n${error.message}`
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Question text updated."
      );

      await showQuestionEdit(
        chatId,
        questionId
      );

      return;
    }

    if (
      session.state ===
      "question_edit_marks"
    ) {
      const marks = Number(text);

      if (
        !Number.isFinite(marks) ||
        marks <= 0
      ) {
        await safeSend(
          chatId,
          "❌ Marks must be greater than 0."
        );
        return;
      }

      const questionId =
        session.data.questionId;

      const { error } = await supabase
        .from("questions")
        .update({
          marks,
        })
        .eq("id", questionId);

      if (error) {
        await safeSend(
          chatId,
          `❌ Update failed.\n\n${error.message}`
        );
        return;
      }

      const { data: q } =
        await supabase
          .from("questions")
          .select("test_id")
          .eq("id", questionId)
          .single();

      if (q) {
        await recalculateTestTotals(
          q.test_id
        );
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Marks updated."
      );

      await showQuestionEdit(
        chatId,
        questionId
      );

      return;
    }

    if (
      session.state ===
      "question_edit_negative"
    ) {
      const negative = Number(text);

      if (
        !Number.isFinite(negative) ||
        negative < 0
      ) {
        await safeSend(
          chatId,
          "❌ Negative marks cannot be below 0."
        );
        return;
      }

      const questionId =
        session.data.questionId;

      const { error } = await supabase
        .from("questions")
        .update({
          negative_marks:
            negative,
        })
        .eq("id", questionId);

      if (error) {
        await safeSend(
          chatId,
          `❌ Update failed.\n\n${error.message}`
        );
        return;
      }

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Negative marks updated."
      );

      await showQuestionEdit(
        chatId,
        questionId
      );

      return;
    }

  } catch (error) {
    console.error(
      "Message handler error:",
      error
    );

    await safeSend(
      msg.chat.id,
      "❌ Something went wrong. Please try again."
    );
  }
});

// ============================================================
// COMMANDS
// ============================================================

bot.onText(/^\/start$/, async (msg) => {
  await safeSend(
    msg.chat.id,
    `🛡️ *PrepArena Admin Bot*

Welcome, ${escapeMarkdown(
      displayName(msg.from)
    )}.

Use /admin to login.
Use /cancel to cancel the current operation.`,
    {
      parse_mode: "Markdown",
    }
  );
});

bot.onText(/^\/admin$/, async (msg) => {
  try {
    const userId = msg.from.id;
    const admin = await getAdmin(userId);

    if (!admin || admin.is_active !== true) {
      await safeSend(
        msg.chat.id,
        "❌ You are not authorized to use the PrepArena Admin Bot."
      );
      return;
    }

    await sendLoginPrompt(
      msg.chat.id
    );
  } catch (error) {
    console.error(
      "/admin error:",
      error
    );

    await safeSend(
      msg.chat.id,
      "❌ Unable to start login."
    );
  }
});

bot.onText(/^\/cancel$/, async (msg) => {
  const userId = msg.from.id;
  const session = getSession(userId);

  if (!session) {
    await safeSend(
      msg.chat.id,
      "Nothing to cancel."
    );
    return;
  }

  if (
    session.authenticated === true
  ) {
    setSession(userId, {
      authenticated: true,
      role: session.role,
      state: null,
      data: {},
    });

    await safeSend(
      msg.chat.id,
      "❌ Current operation cancelled."
    );

    await sendAdminPanel(
      msg.chat.id
    );
  } else {
    clearSession(userId);

    await safeSend(
      msg.chat.id,
      "❌ Login cancelled."
    );
  }
});

// ============================================================
// CALLBACK HANDLER
// ============================================================

bot.on(
  "callback_query",
  async (query) => {
    const chatId =
      query.message.chat.id;
    const userId =
      query.from.id;
    const data =
      query.data || "";

    await answerCallback(
      query.id
    );

    try {
      // ------------------------------------------------------
      // PUBLIC / NOOP
      // ------------------------------------------------------

      if (data === "noop") {
        return;
      }

      if (data === "cancel") {
        const session =
          getSession(userId);

        if (session?.authenticated) {
          setSession(userId, {
            authenticated: true,
            role: session.role,
            state: null,
            data: {},
          });

          await safeSend(
            chatId,
            "❌ Operation cancelled."
          );

          await sendAdminPanel(
            chatId
          );
        } else {
          clearSession(userId);

          await safeSend(
            chatId,
            "❌ Operation cancelled."
          );
        }

        return;
      }

      // ------------------------------------------------------
      // AUTH
      // ------------------------------------------------------

      const session =
        requireAuth(userId);

      if (!session) {
        await safeSend(
          chatId,
          "🔐 Session expired. Please use /admin to login again."
        );
        return;
      }

      // ------------------------------------------------------
      // PANEL
      // ------------------------------------------------------

      if (data === "panel") {
        await sendAdminPanel(
          chatId
        );
        return;
      }

      if (data === "logout") {
        clearSession(userId);

        await safeSend(
          chatId,
          "🚪 Logged out successfully.\n\nUse /admin to login again."
        );

        return;
      }

      if (data === "help") {
        await sendHelp(chatId);
        return;
      }

      // ------------------------------------------------------
      // CREATE
      // ------------------------------------------------------

      if (data === "create") {
        await startCreateTest(
          chatId
        );
        return;
      }

      // ------------------------------------------------------
      // TEST LIST
      // ------------------------------------------------------

      if (data === "tests") {
        await sendTestList(
          chatId
        );
        return;
      }

      // ------------------------------------------------------
      // TEST DETAIL
      // ------------------------------------------------------

      if (data.startsWith("tm_")) {
        const testId =
          data.substring(3);

        await sendTestDetail(
          chatId,
          testId
        );
        return;
      }

      // ------------------------------------------------------
      // EDIT TEST MENU
      // ------------------------------------------------------

      if (data.startsWith("te_")) {
        const testId =
          data.substring(3);

        await showEditTestMenu(
          chatId,
          testId
        );
        return;
      }

      // ------------------------------------------------------
      // EDIT TEST FIELD
      // ------------------------------------------------------

      if (data.startsWith("et_")) {
        const parts =
          data.split("_");

        const testId = parts[1];
        const field = parts[2];

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state: `edit_test_${field}`,
          data: {
            testId,
          },
        });

        const prompts = {
          title:
            "Enter new test title:",
          desc:
            "Enter new description.\nSend `-` to clear it.",
          date:
            "Enter new date in YYYY-MM-DD format.\nSend `-` to clear it.",
          time:
            "Enter new time in HH:MM format.\nSend `-` to clear it.",
          dur:
            "Enter new duration in minutes:",
          marks:
            "Enter new marks per question:",
          neg:
            "Enter new negative marking value:",
          inst:
            "Enter new instructions.\nSend `-` to clear them.",
        };

        await safeSend(
          chatId,
          `✏️ ${prompts[field] || "Enter new value:"}`
        );

        return;
      }

      // ------------------------------------------------------
      // TEST SUBJECTS
      // ------------------------------------------------------

      if (data.startsWith("ts_")) {
        const testId =
          data.substring(3);

        await sendTestSubjects(
          chatId,
          testId
        );
        return;
      }

      if (data.startsWith("tx_")) {
        const parts =
          data.split("_");

        const testId = parts[1];
        const subjectId = parts[2];

        const { data: existing } =
          await supabase
            .from("test_subjects")
            .select("*")
            .eq("test_id", testId)
            .eq(
              "subject_id",
              subjectId
            )
            .maybeSingle();

        if (existing) {
          await supabase
            .from("test_subjects")
            .delete()
            .eq("test_id", testId)
            .eq(
              "subject_id",
              subjectId
            );
        } else {
          await supabase
            .from("test_subjects")
            .insert({
              test_id: testId,
              subject_id: subjectId,
            });
        }

        await sendTestSubjects(
          chatId,
          testId
        );
        return;
      }

      // ------------------------------------------------------
      // PUBLISH / END
      // ------------------------------------------------------

      if (data.startsWith("pub_")) {
        await publishTest(
          chatId,
          data.substring(4)
        );
        return;
      }

      if (data.startsWith("end_")) {
        const testId =
          data.substring(4);

        await safeSend(
          chatId,
          "⚠️ Are you sure you want to end this test?",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔴 Yes, End Test",
                    callback_data: `endy_${testId}`,
                  },
                  {
                    text: "↩️ Cancel",
                    callback_data: `tm_${testId}`,
                  },
                ],
              ],
            },
          }
        );

        return;
      }

      if (data.startsWith("endy_")) {
        await endTest(
          chatId,
          data.substring(5)
        );
        return;
      }

      // ------------------------------------------------------
      // QUESTION MENU
      // ------------------------------------------------------

      if (data.startsWith("q_")) {
        const testId =
          data.substring(2);

        await sendQuestionMenu(
          chatId,
          testId
        );
        return;
      }

      // ------------------------------------------------------
      // ADD QUESTION
      // ------------------------------------------------------

      if (data.startsWith("qa_")) {
        await startAddQuestion(
          chatId,
          data.substring(3)
        );
        return;
      }

      // ------------------------------------------------------
      // QUESTION TYPE
      // ------------------------------------------------------

      if (data.startsWith("qt_")) {
        const parts =
          data.split("_");

        const shortType = parts[1];
        const testId = parts[2];

        const typeMap = {
          m: "mcq",
          c: "multiple_correct",
          n: "numerical",
        };

        const type =
          typeMap[shortType];

        if (!type) {
          await safeSend(
            chatId,
            "❌ Invalid question type."
          );
          return;
        }

        await startQuestionAfterType(
          chatId,
          type,
          testId
        );

        return;
      }

      // ------------------------------------------------------
      // VIEW QUESTIONS
      // ------------------------------------------------------

      if (data.startsWith("qv_")) {
        const parts =
          data.split("_");

        await viewQuestions(
          chatId,
          parts[1],
          Number(parts[2]) || 0
        );

        return;
      }

      // ------------------------------------------------------
      // EDIT QUESTION LIST
      // ------------------------------------------------------

      if (data.startsWith("qe_")) {
        const parts =
          data.split("_");

        await editQuestionList(
          chatId,
          parts[1],
          Number(parts[2]) || 0
        );

        return;
      }

      // ------------------------------------------------------
      // EDIT QUESTION
      // ------------------------------------------------------

      if (data.startsWith("qee_")) {
        await showQuestionEdit(
          chatId,
          data.substring(4)
        );
        return;
      }

      if (data.startsWith("qet_")) {
        const questionId =
          data.substring(4);

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "question_edit_text",
          data: {
            questionId,
          },
        });

        await safeSend(
          chatId,
          "📝 Enter the new question text:"
        );

        return;
      }

      if (data.startsWith("qem_")) {
        const questionId =
          data.substring(4);

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "question_edit_marks",
          data: {
            questionId,
          },
        });

        await safeSend(
          chatId,
          "💯 Enter new marks:"
        );

        return;
      }

      if (data.startsWith("qen_")) {
        const questionId =
          data.substring(4);

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "question_edit_negative",
          data: {
            questionId,
          },
        });

        await safeSend(
          chatId,
          "➖ Enter new negative marks:"
        );

        return;
      }

      if (data.startsWith("qec_")) {
        const questionId =
          data.substring(4);

        await safeSend(
          chatId,
          "🔢 Changing question type rebuilds its options. Choose the new type:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔘 MCQ",
                    callback_data: `qc_m_${questionId}`,
                  },
                ],
                [
                  {
                    text: "☑️ Multiple Correct",
                    callback_data: `qc_c_${questionId}`,
                  },
                ],
                [
                  {
                    text: "🔢 Numerical",
                    callback_data: `qc_n_${questionId}`,
                  },
                ],
              ],
            },
          }
        );

        return;
      }

      // ------------------------------------------------------
      // CHANGE QUESTION TYPE
      // ------------------------------------------------------

      if (data.startsWith("qc_")) {
        const parts =
          data.split("_");

        const shortType = parts[1];
        const questionId = parts[2];

        const typeMap = {
          m: "mcq",
          c: "multiple_correct",
          n: "numerical",
        };

        const newType =
          typeMap[shortType];

        const { data: q } =
          await supabase
            .from("questions")
            .select("*")
            .eq("id", questionId)
            .single();

        if (!q) {
          await safeSend(
            chatId,
            "❌ Question not found."
          );
          return;
        }

        const { data: test } =
          await supabase
            .from("tests")
            .select("status")
            .eq("id", q.test_id)
            .single();

        if (
          !test ||
          test.status !== "draft"
        ) {
          await safeSend(
            chatId,
            "🔒 Test is not editable."
          );
          return;
        }

        const { data: existingKey } =
          await supabase
            .from("answer_keys")
            .select("id")
            .eq(
              "question_id",
              questionId
            )
            .maybeSingle();

        if (existingKey) {
          await safeSend(
            chatId,
            "🔒 This question already has an answer key and cannot be changed."
          );
          return;
        }

        await supabase
          .from("question_options")
          .delete()
          .eq(
            "question_id",
            questionId
          );

        const { error } =
          await supabase
            .from("questions")
            .update({
              question_type: newType,
            })
            .eq("id", questionId);

        if (error) {
          await safeSend(
            chatId,
            `❌ Type change failed.\n\n${error.message}`
          );
          return;
        }

        setSession(userId, {
          ...requireAuth(userId),
          state:
            newType === "numerical"
              ? "edit_num_answer"
              : "edit_option_1",
          data: {
            questionId,
            newType,
            options: [],
          },
        });

        if (newType === "numerical") {
          await safeSend(
            chatId,
            "🔢 Enter the numerical answer:"
          );
        } else {
          await safeSend(
            chatId,
            "A️⃣ Enter Option A:"
          );
        }

        return;
      }

      // ------------------------------------------------------
      // DELETE QUESTION LIST
      // ------------------------------------------------------

      if (data.startsWith("qd_")) {
        const parts =
          data.split("_");

        await deleteQuestionList(
          chatId,
          parts[1],
          Number(parts[2]) || 0
        );

        return;
      }

      if (data.startsWith("qdx_")) {
        await confirmDeleteQuestion(
          chatId,
          data.substring(4)
        );
        return;
      }

      if (data.startsWith("qdy_")) {
        await deleteQuestion(
          chatId,
          data.substring(4)
        );
        return;
      }

      // ------------------------------------------------------
      // SUBJECTS
      // ------------------------------------------------------

      if (data === "subs") {
        await sendSubjectsMenu(
          chatId
        );
        return;
      }

      if (data === "subadd") {
        await startAddSubject(
          chatId
        );
        return;
      }

      if (data.startsWith("sub_")) {
        await sendSubjectDetail(
          chatId,
          data.substring(4)
        );
        return;
      }

      // SUBJECT RENAME
      if (data.startsWith("sr_")) {
        const subjectId =
          data.substring(3);

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "subject_rename",
          data: {
            subjectId,
          },
        });

        await safeSend(
          chatId,
          "✏️ Enter the new subject name:"
        );

        return;
      }

      // SUBJECT TOGGLE
      if (data.startsWith("st_")) {
        const subjectId =
          data.substring(3);

        const { data: subject } =
          await supabase
            .from("subjects")
            .select("is_active")
            .eq("id", subjectId)
            .single();

        if (!subject) {
          await safeSend(
            chatId,
            "❌ Subject not found."
          );
          return;
        }

        const { error } =
          await supabase
            .from("subjects")
            .update({
              is_active:
                !subject.is_active,
            })
            .eq("id", subjectId);

        if (error) {
          await safeSend(
            chatId,
            `❌ Failed to update subject.\n\n${error.message}`
          );
          return;
        }

        await sendSubjectDetail(
          chatId,
          subjectId
        );

        return;
      }

      // ------------------------------------------------------
      // ADMINS
      // ------------------------------------------------------

      if (data === "admins") {
        await sendAdminsMenu(
          chatId
        );
        return;
      }

      if (data === "adda") {
        await startAddAdmin(
          chatId
        );
        return;
      }

      if (data === "ma") {
        const owner =
          requireOwner(userId);

        if (!owner) {
          await safeSend(
            chatId,
            "🔒 Owner access required."
          );
          return;
        }

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "admin_manage_id",
          data: {},
        });

        await safeSend(
          chatId,
          "👤 Enter the Telegram ID of the admin to manage:"
        );

        return;
      }

      if (data.startsWith("ad_")) {
        const owner =
          requireOwner(userId);

        if (!owner) {
          await safeSend(
            chatId,
            "🔒 Owner access required."
          );
          return;
        }

        const targetId =
          Number(data.substring(3));

        if (targetId === OWNER_ID) {
          await safeSend(
            chatId,
            "❌ Owner cannot be disabled."
          );
          return;
        }

        const { data: target } =
          await supabase
            .from("telegram_admins")
            .select("is_active")
            .eq(
              "telegram_user_id",
              targetId
            )
            .single();

        if (!target) {
          await safeSend(
            chatId,
            "❌ Admin not found."
          );
          return;
        }

        await supabase
          .from("telegram_admins")
          .update({
            is_active:
              !target.is_active,
            updated_at:
              new Date().toISOString(),
          })
          .eq(
            "telegram_user_id",
            targetId
          )
          .eq("role", "admin");

        await sendAdminsMenu(
          chatId
        );

        return;
      }

      if (data.startsWith("ap_")) {
        const owner =
          requireOwner(userId);

        if (!owner) {
          await safeSend(
            chatId,
            "🔒 Owner access required."
          );
          return;
        }

        const targetId =
          Number(data.substring(3));

        const session =
          requireAuth(userId);

        setSession(userId, {
          ...session,
          state:
            "admin_change_password",
          data: {
            targetId,
          },
        });

        await safeSend(
          chatId,
          "🔐 Enter the new password for this admin:"
        );

        return;
      }

      if (data.startsWith("ar_")) {
        const owner =
          requireOwner(userId);

        if (!owner) {
          await safeSend(
            chatId,
            "🔒 Owner access required."
          );
          return;
        }

        const targetId =
          Number(data.substring(3));

        if (targetId === OWNER_ID) {
          await safeSend(
            chatId,
            "❌ Owner cannot be removed."
          );
          return;
        }

        await safeSend(
          chatId,
          `⚠️ Remove admin \`${targetId}\` permanently?`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "❌ Yes, Remove",
                    callback_data: `ary_${targetId}`,
                  },
                  {
                    text: "↩️ Cancel",
                    callback_data: "admins",
                  },
                ],
              ],
            },
          }
        );

        return;
      }

      if (data.startsWith("ary_")) {
        const owner =
          requireOwner(userId);

        if (!owner) {
          await safeSend(
            chatId,
            "🔒 Owner access required."
          );
          return;
        }

        const targetId =
          Number(data.substring(4));

        if (targetId === OWNER_ID) {
          await safeSend(
            chatId,
            "❌ Owner cannot be removed."
          );
          return;
        }

        const { error } =
          await supabase
            .from("telegram_admins")
            .delete()
            .eq(
              "telegram_user_id",
              targetId
            )
            .eq("role", "admin");

        if (error) {
          await safeSend(
            chatId,
            `❌ Remove failed.\n\n${error.message}`
          );
          return;
        }

        await safeSend(
          chatId,
          "✅ Admin removed successfully."
        );

        await sendAdminsMenu(
          chatId
        );

        return;
      }

      // ------------------------------------------------------
      // RESULTS
      // ------------------------------------------------------

      if (data === "results") {
        await sendResultsMenu(
          chatId
        );
        return;
      }

      if (data.startsWith("tr_")) {
        await sendTestResults(
          chatId,
          data.substring(3)
        );
        return;
      }

      // ------------------------------------------------------
      // ANSWER KEY
      // ------------------------------------------------------

      if (data.startsWith("ak_")) {
        await sendAnswerKeyMenu(
          chatId,
          data.substring(3)
        );
        return;
      }

      console.log(
        "Unhandled callback:",
        data
      );
    } catch (error) {
      console.error(
        "Callback handler error:",
        error
      );

      await safeSend(
        chatId,
        "❌ Something went wrong. Please try again."
      );
    }
  }
);

// ============================================================
// EXTRA QUESTION EDIT INPUT STATES
// ============================================================

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;

    if (msg.text.startsWith("/")) {
      return;
    }

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = getSession(userId);

    if (!session?.authenticated) {
      return;
    }

    if (
      session.state === "edit_option_1" ||
      session.state === "edit_option_2" ||
      session.state === "edit_option_3" ||
      session.state === "edit_option_4"
    ) {
      const value =
        msg.text.trim();

      if (!value) {
        await safeSend(
          chatId,
          "❌ Option cannot be empty."
        );
        return;
      }

      const index =
        Number(
          session.state.split("_")[2]
        ) - 1;

      session.data.options[index] =
        value;

      if (index < 3) {
        session.state =
          `edit_option_${index + 2}`;

        await safeSend(
          chatId,
          `${["A", "B", "C", "D"][index + 1]}️⃣ Enter Option ${
            ["A", "B", "C", "D"][index + 1]
          }:`
        );

        return;
      }

      await saveEditedQuestionOptions(
        chatId,
        session
      );

      return;
    }

    if (
      session.state ===
      "edit_num_answer"
    ) {
      const value =
        msg.text.trim();

      if (!value) {
        await safeSend(
          chatId,
          "❌ Numerical answer cannot be empty."
        );
        return;
      }

      const questionId =
        session.data.questionId;

      const { error } =
        await supabase
          .from("questions")
          .select("id")
          .eq("id", questionId)
          .single();

      if (error) {
        await safeSend(
          chatId,
          "❌ Question not found."
        );
        return;
      }

      /*
        The current questions schema does not have a
        numerical answer column. The actual answer key
        is intentionally deferred until Answer Key Upload.

        Therefore we do not store the correct numerical
        answer here.
      */

      setSession(userId, {
        ...session,
        state: null,
        data: {},
      });

      await safeSend(
        chatId,
        "✅ Question type changed to Numerical.\n\nCorrect numerical answer will be added later in Answer Key."
      );

      await showQuestionEdit(
        chatId,
        questionId
      );
    }
  } catch (error) {
    console.error(
      "Secondary message handler error:",
      error
    );
  }
});

// ============================================================
// SAVE EDITED OPTIONS
// ============================================================

async function saveEditedQuestionOptions(
  chatId,
  session
) {
  const questionId =
    session.data.questionId;

  const options =
    session.data.options;

  const labels = [
    "A",
    "B",
    "C",
    "D",
  ];

  await supabase
    .from("question_options")
    .delete()
    .eq(
      "question_id",
      questionId
    );

  const rows = options.map(
    (text, index) => ({
      question_id: questionId,
      option_label: labels[index],
      option_text: text,
      option_order: index + 1,
    })
  );

  const { error } =
    await supabase
      .from("question_options")
      .insert(rows);

  if (error) {
    await safeSend(
      chatId,
      `❌ Options update failed.\n\n${error.message}`
    );
    return;
  }

  setSession(chatId, {
    authenticated: true,
    role: session.role,
    state: null,
    data: {},
  });

  await safeSend(
    chatId,
    "✅ Options updated successfully."
  );

  await showQuestionEdit(
    chatId,
    questionId
  );
}

// ============================================================
// UTILITIES
// ============================================================

function truncate(text, max) {
  const value = String(text || "");

  if (value.length <= max) {
    return value;
  }

  return value.substring(0, max - 3) + "...";
}

function formatQuestionType(type) {
  if (type === "mcq") {
    return "MCQ";
  }

  if (type === "multiple_correct") {
    return "Multiple Correct";
  }

  if (type === "numerical") {
    return "Numerical";
  }

  return type;
}

function escapeMarkdown(text) {
  return String(text || "")
    .replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// ============================================================
// ERROR HANDLING
// ============================================================

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

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

// ============================================================
// STARTUP
// ============================================================

(async () => {
  try {
    await ensureOwnerAccount();

    console.log(
      "✅ PrepArena Admin Bot is running."
    );
  } catch (error) {
    console.error(
      "❌ Startup failed:",
      error
    );

    process.exit(1);
  }
})();
