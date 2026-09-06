const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const token = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const ownerPassword = process.env.OWNER_PASSWORD;

if (!token) {
  throw new Error("BOT_TOKEN is not configured");
}

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is not configured");
}

if (!supabaseSecretKey) {
  throw new Error("SUPABASE_SECRET_KEY is not configured");
}

if (!ownerPassword) {
  throw new Error("OWNER_PASSWORD is not configured");
}

// ===============================
// INITIALIZE
// ===============================

const bot = new TelegramBot(token, {
  polling: true,
});

const supabase = createClient(
  supabaseUrl,
  supabaseSecretKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ===============================
// OWNER
// ===============================

const OWNER_ID = 8256722518;

// ===============================
// SESSIONS
// ===============================

const addTestSessions = new Map();
const subjectSessions = new Map();
const authSessions = new Map();
const adminSessions = new Map();

// ===============================
// PASSWORD HASHING
// ===============================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");

  const derivedKey = crypto.scryptSync(
    password,
    salt,
    64
  );

  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = storedHash.split(":");

    if (parts.length !== 3) {
      return false;
    }

    const [, salt, keyHex] = parts;

    const storedKey = Buffer.from(keyHex, "hex");

    const derivedKey = crypto.scryptSync(
      password,
      salt,
      storedKey.length
    );

    return crypto.timingSafeEqual(
      storedKey,
      derivedKey
    );
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}

// ===============================
// AUTH DATABASE
// ===============================

async function ensureOwnerAccount() {
  try {
    const { data: existing, error } = await supabase
      .from("telegram_admins")
      .select("telegram_user_id,role,is_active")
      .eq("telegram_user_id", OWNER_ID)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (existing) {
      if (
        existing.role !== "owner" ||
        !existing.is_active
      ) {
        const { error: updateError } = await supabase
          .from("telegram_admins")
          .update({
            role: "owner",
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq("telegram_user_id", OWNER_ID);

        if (updateError) throw updateError;
      }

      console.log("👑 Owner account already exists.");
      return;
    }

    const passwordHash = hashPassword(ownerPassword);

    const { error: insertError } = await supabase
      .from("telegram_admins")
      .insert({
        telegram_user_id: OWNER_ID,
        role: "owner",
        password_hash: passwordHash,
        is_active: true,
      });

    if (insertError) {
      throw insertError;
    }

    console.log("👑 Owner account created successfully.");
  } catch (error) {
    console.error(
      "Owner account setup error:",
      error
    );

    throw error;
  }
}

async function getAdmin(telegramUserId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id,role,password_hash,is_active"
    )
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error) {
    console.error("Admin lookup error:", error);
    return null;
  }

  if (!data || !data.is_active) {
    return null;
  }

  return data;
}

async function isAuthorizedAdmin(telegramUserId) {
  const admin = await getAdmin(telegramUserId);
  return !!admin;
}

// ===============================
// DELETE PASSWORD MESSAGE
// ===============================

async function tryDeleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    // Telegram may reject deletion depending on chat/message state.
  }
}

// ===============================
// AUTH FLOW
// ===============================

async function requestPassword(
  chatId,
  telegramUserId,
  action
) {
  authSessions.set(chatId, {
    telegramUserId,
    action,
    createdAt: Date.now(),
  });

  await bot.sendMessage(
    chatId,
    "🔐 *Admin Authentication Required*\n\nEnter your admin password:",
    {
      parse_mode: "Markdown",
    }
  );
}

async function requireAuth(msg, action) {
  if (!msg.from) return false;

  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ You are not authorized to use the PrepArena Admin Bot."
    );

    return false;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    action
  );

  return false;
}

// ===============================
// RUN AUTHENTICATED ACTION
// ===============================

async function executeAuthenticatedAction(
  chatId,
  telegramUserId,
  action
) {
  try {
    if (action.type === "start") {
      await sendAdminPanel(chatId);
      return;
    }

    if (action.type === "help") {
      await sendHelp(chatId);
      return;
    }

    if (action.type === "addtest") {
      await startCreateTest(chatId);
      return;
    }

    if (action.type === "tests") {
      await showTests(chatId);
      return;
    }

    if (action.type === "removetest") {
      await showRemoveTests(chatId);
      return;
    }

    if (action.type === "subs") {
      await showSubjectsMenu(chatId);
      return;
    }

    if (action.type === "cancel") {
      cancelSessions(chatId);

      await bot.sendMessage(
        chatId,
        "❌ Current operation cancelled."
      );

      return;
    }

    if (action.type === "create_test") {
      await startCreateTest(chatId);
      return;
    }

    if (action.type === "subjects_menu") {
      await showSubjectsMenu(chatId);
      return;
    }

    if (action.type === "subject_add") {
      subjectSessions.set(chatId, {
        step: "add",
        data: {},
      });

      await bot.sendMessage(
        chatId,
        "➕ *Add Subject*\n\nEnter the subject name:",
        { parse_mode: "Markdown" }
      );

      return;
    }

    if (action.type === "subject_list") {
      await showSubjectsList(chatId);
      return;
    }

    if (action.type === "manage_tests") {
      await showTests(chatId);
      return;
    }

    if (action.type === "results") {
      await bot.sendMessage(
        chatId,
        "🏆 *Results*\n\nResults management will be connected after the test-taking and scoring system is completed.",
        { parse_mode: "Markdown" }
      );

      return;
    }

    if (action.type === "view_test") {
      await showTestDetails(
        chatId,
        action.testId
      );

      return;
    }

    if (action.type === "back_tests") {
      await showTests(chatId);
      return;
    }

    if (action.type === "add_questions") {
      await bot.sendMessage(
        chatId,
        `📝 *Question Editor*\n\nTest ID:\n\`${action.testId}\`\n\nQuestion editor will be connected to the questions table in the next phase.`,
        { parse_mode: "Markdown" }
      );

      return;
    }

    if (action.type === "publish_test") {
      await publishTest(
        chatId,
        action.testId
      );

      return;
    }

    if (action.type === "remove_test") {
      await removeTest(
        chatId,
        action.testId
      );

      return;
    }

    if (action.type === "edit_subject") {
      await beginEditSubject(
        chatId,
        action.subjectId
      );

      return;
    }

    if (action.type === "remove_subject") {
      await removeSubject(
        chatId,
        action.subjectId
      );

      return;
    }

    if (action.type === "test_subject") {
      await toggleTestSubject(
        chatId,
        action.subjectId
      );

      return;
    }

    if (action.type === "test_subject_done") {
      await finishSubjectSelection(chatId);
      return;
    }

    if (action.type === "admins") {
      await showAdmins(chatId);
      return;
    }

    if (action.type === "add_admin") {
      if (
        telegramUserId !== OWNER_ID
      ) {
        await bot.sendMessage(
          chatId,
          "⛔ Only the Owner can add admins."
        );
        return;
      }

      adminSessions.set(chatId, {
        step: "add_admin_id",
      });

      await bot.sendMessage(
        chatId,
        "➕ *Add Admin*\n\nEnter the Telegram numeric ID of the new admin:",
        { parse_mode: "Markdown" }
      );

      return;
    }

    if (action.type === "remove_admin") {
      if (
        telegramUserId !== OWNER_ID
      ) {
        await bot.sendMessage(
          chatId,
          "⛔ Only the Owner can remove admins."
        );
        return;
      }

      await showRemoveAdmins(chatId);
      return;
    }

    if (action.type === "end_test") {
      await endTest(
        chatId,
        action.testId
      );

      return;
    }

    if (action.type === "answer_key") {
      await beginAnswerKeyUpload(
        chatId,
        action.testId
      );

      return;
    }
  } catch (error) {
    console.error(
      "Authenticated action error:",
      error
    );

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while processing the action."
    );
  }
}

// ===============================
// PASSWORD MESSAGE HANDLER
// ===============================

async function handlePasswordMessage(msg) {
  const session = authSessions.get(
    msg.chat.id
  );

  if (!session) return false;

  if (
    session.telegramUserId !== msg.from.id
  ) {
    return false;
  }

  const password = msg.text.trim();

  authSessions.delete(msg.chat.id);

  await tryDeleteMessage(
    msg.chat.id,
    msg.message_id
  );

  const admin = await getAdmin(
    msg.from.id
  );

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Your admin access is no longer active."
    );

    return true;
  }

  const valid = verifyPassword(
    password,
    admin.password_hash
  );

  if (!valid) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Incorrect password.\n\nPlease use the command/button again to retry."
    );

    return true;
  }

  await bot.sendMessage(
    msg.chat.id,
    "✅ Authentication successful."
  );

  await executeAuthenticatedAction(
    msg.chat.id,
    msg.from.id,
    session.action
  );

  return true;
}

// ===============================
// START
// ===============================

bot.onText(/^\/start$/, async (msg) => {
  const admin = await getAdmin(
    msg.from.id
  );

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ You are not authorized to use the PrepArena Admin Bot."
    );

    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "start" }
  );
});

// ===============================
// ADMIN PANEL
// ===============================

async function sendAdminPanel(chatId) {
  await bot.sendMessage(
    chatId,
    "👑 *PrepArena Admin Panel*\n\nWelcome!\nManage tests, subjects and administration.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Create Test",
              callback_data: "create_test",
            },
          ],
          [
            {
              text: "📚 Manage Tests",
              callback_data: "manage_tests",
            },
          ],
          [
            {
              text: "📖 Subjects",
              callback_data: "subjects_menu",
            },
          ],
          [
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
        ],
      },
    }
  );
}

// ===============================
// HELP
// ===============================

async function sendHelp(chatId) {
  await bot.sendMessage(
    chatId,
    `👑 *PrepArena Admin Bot*

Commands:

/addtest - Create a new test
/tests - View all tests
/removetest - Remove a test
/subs - Manage subjects
/cancel - Cancel current operation

Owner:
• Manage admins
• Set admin passwords
• Remove admins

Admin:
• Create/manage tests
• Manage subjects
• End tests

Security:
• Password required for every command/button action
• No persistent authenticated session
• Passwords are stored as secure hashes`,
    { parse_mode: "Markdown" }
  );
}

bot.onText(/^\/help$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "help" }
  );
});

// ===============================
// COMMANDS
// ===============================

bot.onText(/^\/addtest$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "addtest" }
  );
});

bot.onText(/^\/tests$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "tests" }
  );
});

bot.onText(/^\/removetest$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "removetest" }
  );
});

bot.onText(/^\/subs$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "subs" }
  );
});

bot.onText(/^\/admins$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "admins" }
  );
});

bot.onText(/^\/cancel$/, async (msg) => {
  const admin = await getAdmin(msg.from.id);

  if (!admin) {
    await bot.sendMessage(
      msg.chat.id,
      "⛔ Unauthorized."
    );
    return;
  }

  await requestPassword(
    msg.chat.id,
    msg.from.id,
    { type: "cancel" }
  );
});

// ===============================
// MESSAGE HANDLER
// ===============================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  if (msg.text.startsWith("/")) return;

  // Password authentication takes priority
  if (
    authSessions.has(msg.chat.id)
  ) {
    await handlePasswordMessage(msg);
    return;
  }

  const admin = await getAdmin(
    msg.from.id
  );

  if (!admin) return;

  // -------------------------------
  // ADMIN MANAGEMENT SESSION
  // -------------------------------

  const adminSession = adminSessions.get(
    msg.chat.id
  );

  if (adminSession) {
    await handleAdminInput(
      msg,
      adminSession,
      admin
    );

    return;
  }

  // -------------------------------
  // SUBJECT SESSION
  // -------------------------------

  const subjectSession =
    subjectSessions.get(msg.chat.id);

  if (subjectSession) {
    await handleSubjectInput(
      msg,
      subjectSession
    );

    return;
  }

  // -------------------------------
  // TEST CREATION SESSION
  // -------------------------------

  const testSession =
    addTestSessions.get(msg.chat.id);

  if (testSession) {
    await handleTestCreationInput(
      msg,
      testSession
    );

    return;
  }
});

// ===============================
// CALLBACK HANDLER
// ===============================

bot.on("callback_query", async (query) => {
  const msg = query.message;

  if (!msg) return;

  const telegramUserId =
    query.from.id;

  const admin = await getAdmin(
    telegramUserId
  );

  if (!admin) {
    await bot.answerCallbackQuery(
      query.id,
      {
        text: "⛔ Unauthorized",
        show_alert: true,
      }
    );

    return;
  }

  await bot.answerCallbackQuery(
    query.id
  );

  const data = query.data;

  // Every button requires fresh password
  await requestPassword(
    msg.chat.id,
    telegramUserId,
    parseCallbackAction(data)
  );
});

// ===============================
// CALLBACK ACTION PARSER
// ===============================

function parseCallbackAction(data) {
  if (data === "create_test") {
    return { type: "create_test" };
  }

  if (data === "subjects_menu") {
    return { type: "subjects_menu" };
  }

  if (data === "subject_add") {
    return { type: "subject_add" };
  }

  if (data === "subject_list") {
    return { type: "subject_list" };
  }

  if (data === "manage_tests") {
    return { type: "manage_tests" };
  }

  if (data === "results") {
    return { type: "results" };
  }

  if (data === "help") {
    return { type: "help" };
  }

  if (data === "back_tests") {
    return { type: "back_tests" };
  }

  if (data === "admins") {
    return { type: "admins" };
  }

  if (data === "add_admin") {
    return { type: "add_admin" };
  }

  if (data === "remove_admin") {
    return { type: "remove_admin" };
  }

  if (data === "test_subject_done") {
    return { type: "test_subject_done" };
  }

  if (data.startsWith("edit_subject_")) {
    return {
      type: "edit_subject",
      subjectId: data.replace(
        "edit_subject_",
        ""
      ),
    };
  }

  if (data.startsWith("remove_subject_")) {
    return {
      type: "remove_subject",
      subjectId: data.replace(
        "remove_subject_",
        ""
      ),
    };
  }

  if (data.startsWith("test_subject_")) {
    return {
      type: "test_subject",
      subjectId: data.replace(
        "test_subject_",
        ""
      ),
    };
  }

  if (data.startsWith("view_test_")) {
    return {
      type: "view_test",
      testId: data.replace(
        "view_test_",
        ""
      ),
    };
  }

  if (data.startsWith("add_questions_")) {
    return {
      type: "add_questions",
      testId: data.replace(
        "add_questions_",
        ""
      ),
    };
  }

  if (data.startsWith("publish_test_")) {
    return {
      type: "publish_test",
      testId: data.replace(
        "publish_test_",
        ""
      ),
    };
  }

  if (data.startsWith("remove_test_")) {
    return {
      type: "remove_test",
      testId: data.replace(
        "remove_test_",
        ""
      ),
    };
  }

  if (data.startsWith("end_test_")) {
    return {
      type: "end_test",
      testId: data.replace(
        "end_test_",
        ""
      ),
    };
  }

  if (data.startsWith("answer_key_")) {
    return {
      type: "answer_key",
      testId: data.replace(
        "answer_key_",
        ""
      ),
    };
  }

  if (data.startsWith("remove_admin_")) {
    return {
      type: "remove_admin",
      adminId: Number(
        data.replace(
          "remove_admin_",
          ""
        )
      ),
    };
  }

  return {
    type: "unknown",
  };
}

// ===============================
// CREATE TEST
// ===============================

function startCreateTest(chatId) {
  addTestSessions.set(chatId, {
    step: "title",
    data: {
      subjectIds: [],
    },
  });

  return bot.sendMessage(
    chatId,
    "➕ *Create New Test*\n\nEnter the *test title*:",
    { parse_mode: "Markdown" }
  );
}

async function handleTestCreationInput(
  msg,
  session
) {
  const value = msg.text.trim();

  if (!value) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Input cannot be empty."
    );
    return;
  }

  if (session.step === "title") {
    session.data.title = value;
    session.step = "description";

    await bot.sendMessage(
      msg.chat.id,
      "📝 Enter test *description*.\n\nOr type `skip`:",
      { parse_mode: "Markdown" }
    );

    return;
  }

  if (session.step === "description") {
    session.data.description =
      value.toLowerCase() === "skip"
        ? null
        : value;

    await showSubjectSelection(
      msg.chat.id,
      session
    );

    return;
  }

  if (session.step === "date") {
    if (!isValidDateFormat(value)) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Invalid date format.\n\nUse `YYYY-MM-DD`.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    session.data.test_date = value;
    session.step = "time";

    await bot.sendMessage(
      msg.chat.id,
      "⏰ Enter test time.\n\nFormat: `HH:MM`\nExample: `19:30`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  if (session.step === "time") {
    const time = normalizeTime(value);

    if (!time) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Invalid time.\n\nUse 24-hour format: `HH:MM`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (
      !isFutureISTDateTime(
        session.data.test_date,
        time
      )
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Test date/time must be strictly in the future.\n\nEnter the test date again:",
        { parse_mode: "Markdown" }
      );

      session.step = "date";
      delete session.data.test_date;

      return;
    }

    session.data.test_time = time;
    session.step = "duration";

    await bot.sendMessage(
      msg.chat.id,
      "⏱ Enter duration in minutes.\n\nExample: `180`"
    );

    return;
  }

  if (session.step === "duration") {
    const duration = Number(value);

    if (
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Enter a valid duration."
      );
      return;
    }

    session.data.duration_minutes =
      duration;

    session.step = "questions";

    await bot.sendMessage(
      msg.chat.id,
      "🔢 Enter total number of questions.\n\nExample: `30`"
    );

    return;
  }

  if (session.step === "questions") {
    const questions = Number(value);

    if (
      !Number.isInteger(questions) ||
      questions < 0
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Enter a valid number of questions."
      );
      return;
    }

    session.data.total_questions =
      questions;

    session.step = "marks";

    await bot.sendMessage(
      msg.chat.id,
      "🏆 Enter total marks.\n\nExample: `120`"
    );

    return;
  }

  if (session.step === "marks") {
    const marks = Number(value);

    if (
      !Number.isInteger(marks) ||
      marks < 0
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Enter a valid total marks value."
      );
      return;
    }

    session.data.total_marks = marks;

    await saveTest(
      msg.chat.id,
      session.data
    );

    addTestSessions.delete(
      msg.chat.id
    );
  }
}

// ===============================
// SUBJECT MENU
// ===============================

async function showSubjectsMenu(chatId) {
  await bot.sendMessage(
    chatId,
    "📖 *Subject Management*\n\nManage reusable subjects.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Subject",
              callback_data: "subject_add",
            },
          ],
          [
            {
              text: "📋 View / Edit / Remove",
              callback_data: "subject_list",
            },
          ],
        ],
      },
    }
  );
}

// ===============================
// SUBJECT LIST
// ===============================

async function showSubjectsList(chatId) {
  const { data: subjects, error } =
    await supabase
      .from("subjects")
      .select("id,name,is_active")
      .eq("is_active", true)
      .order("name", {
        ascending: true,
      });

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Database Error:\n${error.message}`
    );
    return;
  }

  if (!subjects || subjects.length === 0) {
    await bot.sendMessage(
      chatId,
      "📖 No subjects found."
    );
    return;
  }

  const buttons = subjects.map(
    (subject) => [
      {
        text: `✏️ ${subject.name}`,
        callback_data:
          `edit_subject_${subject.id}`,
      },
      {
        text: "🗑",
        callback_data:
          `remove_subject_${subject.id}`,
      },
    ]
  );

  await bot.sendMessage(
    chatId,
    `📖 *Available Subjects*\n\nTotal: ${subjects.length}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// SUBJECT INPUT
// ===============================

async function handleSubjectInput(
  msg,
  session
) {
  const value = msg.text.trim();

  if (!value) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Subject name cannot be empty."
    );
    return;
  }

  if (session.step === "add") {
    const { data: existing } =
      await supabase
        .from("subjects")
        .select("id")
        .ilike("name", value)
        .limit(1);

    if (
      existing &&
      existing.length > 0
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ This subject already exists."
      );
      return;
    }

    const { data, error } =
      await supabase
        .from("subjects")
        .insert({
          name: value,
          is_active: true,
        })
        .select()
        .single();

    if (error) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to add subject.\n\n${error.message}`
      );
      return;
    }

    subjectSessions.delete(
      msg.chat.id
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Subject Added!*\n\n📖 ${data.name}`,
      { parse_mode: "Markdown" }
    );

    return;
  }

  if (session.step === "edit") {
    const subjectId =
      session.data.subjectId;

    const { data: existing } =
      await supabase
        .from("subjects")
        .select("id")
        .ilike("name", value)
        .neq("id", subjectId)
        .limit(1);

    if (
      existing &&
      existing.length > 0
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Another subject with this name already exists."
      );
      return;
    }

    const { data, error } =
      await supabase
        .from("subjects")
        .update({
          name: value,
        })
        .eq("id", subjectId)
        .select()
        .single();

    if (error) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to edit subject.\n\n${error.message}`
      );
      return;
    }

    subjectSessions.delete(
      msg.chat.id
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Subject Updated!*\n\n📖 ${data.name}`,
      { parse_mode: "Markdown" }
    );
  }
}

// ===============================
// BEGIN EDIT SUBJECT
// ===============================

async function beginEditSubject(
  chatId,
  subjectId
) {
  const { data: subject, error } =
    await supabase
      .from("subjects")
      .select("id,name")
      .eq("id", subjectId)
      .single();

  if (error || !subject) {
    await bot.sendMessage(
      chatId,
      "❌ Subject not found."
    );
    return;
  }

  subjectSessions.set(chatId, {
    step: "edit",
    data: {
      subjectId: subject.id,
    },
  });

  await bot.sendMessage(
    chatId,
    `✏️ *Edit Subject*\n\nCurrent name:\n*${subject.name}*\n\nEnter the new name:`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// REMOVE SUBJECT
// ===============================

async function removeSubject(
  chatId,
  subjectId
) {
  const { data: subject, error } =
    await supabase
      .from("subjects")
      .select("id,name")
      .eq("id", subjectId)
      .single();

  if (error || !subject) {
    await bot.sendMessage(
      chatId,
      "❌ Subject not found."
    );
    return;
  }

  const { error: updateError } =
    await supabase
      .from("subjects")
      .update({
        is_active: false,
      })
      .eq("id", subjectId);

  if (updateError) {
    await bot.sendMessage(
      chatId,
      `❌ Unable to remove subject.\n\n${updateError.message}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🗑 *Subject Removed*\n\n📖 ${subject.name}\n\nExisting tests using this subject remain safe.`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// SUBJECT SELECTION
// ===============================

async function showSubjectSelection(
  chatId,
  session
) {
  const { data: subjects, error } =
    await supabase
      .from("subjects")
      .select("id,name,is_active")
      .eq("is_active", true)
      .order("name", {
        ascending: true,
      });

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Unable to load subjects.\n\n${error.message}`
    );
    return;
  }

  if (!subjects || subjects.length === 0) {
    await bot.sendMessage(
      chatId,
      "❌ No active subjects available.\n\nUse /subs first."
    );
    return;
  }

  session.step = "subjects";

  const selected =
    session.data.subjectIds || [];

  const buttons = subjects.map(
    (subject) => [
      {
        text: `${
          selected.includes(subject.id)
            ? "☑️"
            : "⬜"
        } ${subject.name}`,
        callback_data:
          `test_subject_${subject.id}`,
      },
    ]
  );

  buttons.push([
    {
      text: "✅ Done",
      callback_data:
        "test_subject_done",
    },
  ]);

  await bot.sendMessage(
    chatId,
    `📚 *Select Test Subjects*\n\nSelected: *${selected.length}*`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function toggleTestSubject(
  chatId,
  subjectId
) {
  const session =
    addTestSessions.get(chatId);

  if (
    !session ||
    session.step !== "subjects"
  ) {
    await bot.sendMessage(
      chatId,
      "❌ No active test creation session."
    );
    return;
  }

  const selected =
    session.data.subjectIds || [];

  if (selected.includes(subjectId)) {
    session.data.subjectIds =
      selected.filter(
        (id) => id !== subjectId
      );
  } else {
    session.data.subjectIds = [
      ...selected,
      subjectId,
    ];
  }

  await showSubjectSelection(
    chatId,
    session
  );
}

async function finishSubjectSelection(
  chatId
) {
  const session =
    addTestSessions.get(chatId);

  if (
    !session ||
    session.step !== "subjects"
  ) {
    await bot.sendMessage(
      chatId,
      "❌ No active test creation session."
    );
    return;
  }

  if (
    !session.data.subjectIds ||
    session.data.subjectIds.length === 0
  ) {
    await bot.sendMessage(
      chatId,
      "⚠️ Select at least one subject."
    );
    return;
  }

  session.step = "date";

  await bot.sendMessage(
    chatId,
    "📅 Enter test date.\n\nFormat: `YYYY-MM-DD`\nExample: `2026-09-15`",
    { parse_mode: "Markdown" }
  );
}

// ===============================
// SAVE TEST
// ===============================

async function saveTest(
  chatId,
  data
) {
  try {
    const testCode =
      generateTestCode();

    const { data: test, error } =
      await supabase
        .from("tests")
        .insert({
          title: data.title,
          description: data.description,
          test_code: testCode,
          status: "draft",
          test_date: data.test_date,
          test_time: data.test_time,
          duration_minutes:
            data.duration_minutes,
          total_questions:
            data.total_questions,
          total_marks:
            data.total_marks,
          marks_per_question:
            data.total_questions > 0
              ? data.total_marks /
                data.total_questions
              : 4,
          negative_marking_enabled:
            true,
          negative_marking_value: 1,
        })
        .select()
        .single();

    if (error) {
      await bot.sendMessage(
        chatId,
        `❌ Database Error:\n${error.message}`
      );
      return;
    }

    const subjectIds =
      data.subjectIds || [];

    if (subjectIds.length > 0) {
      const relations =
        subjectIds.map(
          (subjectId) => ({
            test_id: test.id,
            subject_id: subjectId,
          })
        );

      const {
        error: relationError,
      } = await supabase
        .from("test_subjects")
        .insert(relations);

      if (relationError) {
        await supabase
          .from("tests")
          .delete()
          .eq("id", test.id);

        await bot.sendMessage(
          chatId,
          `❌ Could not connect subjects.\n\n${relationError.message}`
        );

        return;
      }
    }

    const subjectsText =
      await getTestSubjectsText(
        test.id
      );

    await bot.sendMessage(
      chatId,
      `✅ *Test Created Successfully!*

📚 *Title:* ${test.title}
📖 *Subjects:* ${subjectsText}
📅 *Date:* ${test.test_date}
⏰ *Time:* ${test.test_time}
⏱ *Duration:* ${test.duration_minutes} min
🔢 *Questions:* ${test.total_questions}
🏆 *Total Marks:* ${test.total_marks}

🆔 *Test Code:* \`${test.test_code}\`

Status: 🟡 Draft

Next step: Add Questions`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📝 Add Questions",
                callback_data:
                  `add_questions_${test.id}`,
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error(
      "saveTest error:",
      error
    );

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while creating the test."
    );
  }
}

// ===============================
// TEST SUBJECT TEXT
// ===============================

async function getTestSubjectsText(
  testId
) {
  const { data, error } =
    await supabase
      .from("test_subjects")
      .select(
        `
        subject_id,
        subjects (
          name
        )
      `
      )
      .eq("test_id", testId);

  if (
    error ||
    !data ||
    data.length === 0
  ) {
    return "None";
  }

  return (
    data
      .map(
        (item) =>
          item.subjects?.name
      )
      .filter(Boolean)
      .join(", ") || "None"
  );
}

// ===============================
// GENERATE TEST CODE
// ===============================

function generateTestCode() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "PA-";

  for (let i = 0; i < 6; i++) {
    code +=
      chars[
        Math.floor(
          Math.random() *
            chars.length
        )
      ];
  }

  return code;
}

// ===============================
// DATE VALIDATION
// ===============================

function isValidDateFormat(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      value
    )
  ) {
    return false;
  }

  const [year, month, day] =
    value.split("-").map(Number);

  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day
    )
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() ===
      month - 1 &&
    date.getUTCDate() === day
  );
}

// ===============================
// TIME NORMALIZATION
// ===============================

function normalizeTime(value) {
  const match =
    value.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(
    2,
    "0"
  )}:${String(minute).padStart(
    2,
    "0"
  )}`;
}

// ===============================
// FUTURE IST CHECK
// ===============================

function isFutureISTDateTime(
  dateString,
  timeString
) {
  if (
    !isValidDateFormat(
      dateString
    )
  ) {
    return false;
  }

  const normalizedTime =
    normalizeTime(timeString);

  if (!normalizedTime) {
    return false;
  }

  const [year, month, day] =
    dateString.split("-").map(Number);

  const [hour, minute] =
    normalizedTime
      .split(":")
      .map(Number);

  const testUTC = Date.UTC(
    year,
    month - 1,
    day,
    hour - 5,
    minute - 30,
    0,
    0
  );

  return testUTC > Date.now();
}

// ===============================
// SHOW TESTS
// ===============================

async function showTests(chatId) {
  const { data: tests, error } =
    await supabase
      .from("tests")
      .select(
        "id,title,test_date,test_time,duration_minutes,total_questions,total_marks,status,test_code"
      )
      .order("created_at", {
        ascending: false,
      });

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Database Error:\n${error.message}`
    );
    return;
  }

  if (
    !tests ||
    tests.length === 0
  ) {
    await bot.sendMessage(
      chatId,
      "📚 *Manage Tests*\n\nNo tests found.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const buttons =
    tests.map((test) => [
      {
        text: `${
          test.status === "published"
            ? "🟢"
            : test.status === "ended"
            ? "🔴"
            : "🟡"
        } ${test.title}`,
        callback_data:
          `view_test_${test.id}`,
      },
    ]);

  await bot.sendMessage(
    chatId,
    `📚 *Manage Tests*\n\nTotal: ${tests.length}\n\nSelect a test:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// TEST DETAILS
// ===============================

async function showTestDetails(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .single();

  if (error || !test) {
    await bot.sendMessage(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const subjectsText =
    await getTestSubjectsText(
      test.id
    );

  const statusIcon =
    test.status === "published"
      ? "🟢"
      : test.status === "ended"
      ? "🔴"
      : "🟡";

  const buttons = [];

  if (
    test.status === "draft"
  ) {
    buttons.push([
      {
        text: "📝 Add Questions",
        callback_data:
          `add_questions_${test.id}`,
      },
    ]);

    buttons.push([
      {
        text: "🚀 Publish Test",
        callback_data:
          `publish_test_${test.id}`,
      },
    ]);
  }

  if (
    test.status === "published"
  ) {
    buttons.push([
      {
        text: "🔴 End Test",
        callback_data:
          `end_test_${test.id}`,
      },
    ]);
  }

  if (
    test.status === "ended"
  ) {
    buttons.push([
      {
        text: "🔑 Upload Answer Key",
        callback_data:
          `answer_key_${test.id}`,
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data:
        "back_tests",
    },
  ]);

  await bot.sendMessage(
    chatId,
    `📚 *Test Details*

*${test.title}*

📖 Subjects: ${subjectsText}
🆔 Code: \`${test.test_code || "N/A"}\`

📅 Date: ${test.test_date || "Not set"}
⏰ Time: ${test.test_time || "Not set"}
⏱ Duration: ${test.duration_minutes} minutes

🔢 Questions: ${test.total_questions}
🏆 Total Marks: ${test.total_marks}
➕ Marks/Question: ${test.marks_per_question}
➖ Negative Marking: ${
      test.negative_marking_enabled
        ? test.negative_marking_value
        : "Disabled"
    }

${statusIcon} Status: ${test.status.toUpperCase()}

📝 Description:
${test.description || "No description"}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// PUBLISH TEST
// ===============================

async function publishTest(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select(
        "id,title,total_questions,status,test_date,test_time"
      )
      .eq("id", testId)
      .single();

  if (error || !test) {
    await bot.sendMessage(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (
    test.status !== "draft"
  ) {
    await bot.sendMessage(
      chatId,
      "⚠️ Only draft tests can be published."
    );
    return;
  }

  if (
    test.total_questions <= 0
  ) {
    await bot.sendMessage(
      chatId,
      "⚠️ Add questions before publishing."
    );
    return;
  }

  const { error: updateError } =
    await supabase
      .from("tests")
      .update({
        status: "published",
        updated_at:
          new Date().toISOString(),
      })
      .eq("id", testId)
      .eq("status", "draft");

  if (updateError) {
    await bot.sendMessage(
      chatId,
      `❌ Unable to publish.\n\n${updateError.message}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🚀 *Test Published!*\n\n📚 ${test.title}\n\nStudents can now see this test.`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// END TEST
// ===============================

async function endTest(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select(
        "id,title,status"
      )
      .eq("id", testId)
      .single();

  if (error || !test) {
    await bot.sendMessage(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (
    test.status !== "published"
  ) {
    await bot.sendMessage(
      chatId,
      "⚠️ Only a published test can be ended."
    );
    return;
  }

  const { error: updateError } =
    await supabase
      .from("tests")
      .update({
        status: "ended",
        updated_at:
          new Date().toISOString(),
      })
      .eq("id", testId)
      .eq("status", "published");

  if (updateError) {
    await bot.sendMessage(
      chatId,
      `❌ Unable to end test.\n\n${updateError.message}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🔴 *Test Ended!*

📚 ${test.title}

The answer key can now be uploaded from the Admin Bot.`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// ANSWER KEY UPLOAD START
// ===============================

async function beginAnswerKeyUpload(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select(
        "id,title,status"
      )
      .eq("id", testId)
      .single();

  if (error || !test) {
    await bot.sendMessage(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  // CRITICAL SECURITY RULE
  if (
    test.status !== "ended"
  ) {
    await bot.sendMessage(
      chatId,
      "⛔ Answer key upload is locked.\n\nThe test must be officially ended first."
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🔑 *Answer Key Upload*

Test:
*${test.title}*

Answer-key uploader will be connected to the questions/answer_keys tables in the next phase.

The database rule in this bot only allows this action when the test status is \`ended\`.`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// REMOVE TEST LIST
// ===============================

async function showRemoveTests(
  chatId
) {
  const { data: tests, error } =
    await supabase
      .from("tests")
      .select(
        "id,title,test_date"
      )
      .order("created_at", {
        ascending: false,
      });

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Database Error:\n${error.message}`
    );
    return;
  }

  if (
    !tests ||
    tests.length === 0
  ) {
    await bot.sendMessage(
      chatId,
      "No tests available to remove."
    );
    return;
  }

  const buttons =
    tests.map((test) => [
      {
        text: `🗑 ${test.title} • ${
          test.test_date ||
          "No date"
        }`,
        callback_data:
          `remove_test_${test.id}`,
      },
    ]);

  await bot.sendMessage(
    chatId,
    "🗑 *Remove Test*\n\nSelect a test to permanently delete:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// REMOVE TEST
// ===============================

async function removeTest(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select("title")
      .eq("id", testId)
      .single();

  if (error || !test) {
    await bot.sendMessage(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { error: deleteError } =
    await supabase
      .from("tests")
      .delete()
      .eq("id", testId);

  if (deleteError) {
    await bot.sendMessage(
      chatId,
      `❌ Unable to delete test.\n\n${deleteError.message}`
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `🗑 *Test Deleted*\n\n${test.title}\n\nRelated records with cascade relationships are also removed.`,
    { parse_mode: "Markdown" }
  );
}

// ===============================
// ADMIN MANAGEMENT
// ===============================

async function showAdmins(chatId) {
  const { data: admins, error } =
    await supabase
      .from("telegram_admins")
      .select(
        "telegram_user_id,role,is_active,created_at"
      )
      .eq("is_active", true)
      .order("role", {
        ascending: true,
      });

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Database Error:\n${error.message}`
    );
    return;
  }

  const lines =
    (admins || []).map(
      (admin) =>
        `${admin.role === "owner" ? "👑" : "👤"} ${admin.role.toUpperCase()} — \`${admin.telegram_user_id}\``
    );

  await bot.sendMessage(
    chatId,
    `👥 *Admin Management*\n\n${
      lines.length
        ? lines.join("\n")
        : "No admins found."
    }`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Admin",
              callback_data:
                "add_admin",
            },
          ],
          [
            {
              text: "🗑 Remove Admin",
              callback_data:
                "remove_admin",
            },
          ],
        ],
      },
    }
  );
}

async function handleAdminInput(
  msg,
  session,
  currentAdmin
) {
  if (
    currentAdmin.role !== "owner"
  ) {
    adminSessions.delete(
      msg.chat.id
    );

    await bot.sendMessage(
      msg.chat.id,
      "⛔ Only the Owner can manage admins."
    );

    return;
  }

  const value = msg.text.trim();

  if (
    session.step === "add_admin_id"
  ) {
    if (!/^\d+$/.test(value)) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Enter a valid Telegram numeric ID."
      );
      return;
    }

    const telegramUserId =
      Number(value);

    if (
      telegramUserId === OWNER_ID
    ) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ This ID is already the Owner."
      );
      return;
    }

    const existing =
      await getAdmin(
        telegramUserId
      );

    if (existing) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ This Telegram ID is already an admin."
      );
      return;
    }

    adminSessions.set(msg.chat.id, {
      step: "add_admin_password",
      telegramUserId,
    });

    await bot.sendMessage(
      msg.chat.id,
      "🔑 Enter the new admin's password:"
    );

    return;
  }

  if (
    session.step ===
    "add_admin_password"
  ) {
    if (value.length < 6) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Password must contain at least 6 characters."
      );
      return;
    }

    const passwordHash =
      hashPassword(value);

    const { error } =
      await supabase
        .from("telegram_admins")
        .insert({
          telegram_user_id:
            session.telegramUserId,
          role: "admin",
          password_hash:
            passwordHash,
          is_active: true,
        });

    if (error) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to create admin.\n\n${error.message}`
      );
      return;
    }

    adminSessions.delete(
      msg.chat.id
    );

    await tryDeleteMessage(
      msg.chat.id,
      msg.message_id
    );

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Admin Added!*\n\nTelegram ID: \`${session.telegramUserId}\`\n\nThe new admin can now authenticate with their own password.`,
      { parse_mode: "Markdown" }
    );
  }
}

async function showRemoveAdmins(
  chatId
) {
  const { data: admins, error } =
    await supabase
      .from("telegram_admins")
      .select(
        "telegram_user_id,role,is_active"
      )
      .eq("role", "admin")
      .eq("is_active", true)
      .order(
        "telegram_user_id",
        {
          ascending: true,
        }
      );

  if (error) {
    await bot.sendMessage(
      chatId,
      `❌ Database Error:\n${error.message}`
    );
    return;
  }

  if (
    !admins ||
    admins.length === 0
  ) {
    await bot.sendMessage(
      chatId,
      "No removable admins found."
    );
    return;
  }

  const buttons =
    admins.map((admin) => [
      {
        text: `🗑 ${admin.telegram_user_id}`,
        callback_data:
          `remove_admin_${admin.telegram_user_id}`,
      },
    ]);

  await bot.sendMessage(
    chatId,
    "🗑 *Remove Admin*\n\nSelect an admin:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// CANCEL
// ===============================

function cancelSessions(chatId) {
  addTestSessions.delete(
    chatId
  );

  subjectSessions.delete(
    chatId
  );

  adminSessions.delete(
    chatId
  );

  authSessions.delete(
    chatId
  );
}

// ===============================
// ERROR HANDLERS
// ===============================

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// ===============================
// STARTUP
// ===============================

(async () => {
  try {
    await ensureOwnerAccount();

    console.log(
      "🚀 PrepArena Admin Bot is running..."
    );

    console.log(
      "🗄️ Supabase database connected."
    );
  } catch (error) {
    console.error(
      "❌ Startup failed:",
      error
    );

    process.exit(1);
  }
})();
