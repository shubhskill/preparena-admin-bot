const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ===============================
// ENVIRONMENT VARIABLES
// ===============================

const token = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!token) {
  throw new Error("BOT_TOKEN is not configured");
}

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL is not configured");
}

if (!supabaseSecretKey) {
  throw new Error("SUPABASE_SECRET_KEY is not configured");
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

// Your Telegram Admin ID
const ADMIN_ID = 8256722518;

// Stores users while they are entering test details
const addTestSessions = new Map();

// ===============================
// ADMIN CHECK
// ===============================

function isAdmin(msg) {
  return msg.from && msg.from.id === ADMIN_ID;
}

function adminOnly(msg) {
  if (!isAdmin(msg)) {
    bot.sendMessage(
      msg.chat.id,
      "⛔ You are not authorized to use the Admin Bot."
    );
    return false;
  }

  return true;
}

// ===============================
// START
// ===============================

bot.onText(/^\/start$/, async (msg) => {
  if (!adminOnly(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    "👑 *PrepArena Admin Panel*\n\nWelcome Admin!\nManage tests and prepare them for students.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "➕ Create Test", callback_data: "create_test" },
          ],
          [
            { text: "📚 Manage Tests", callback_data: "manage_tests" },
          ],
          [
            { text: "🏆 Results", callback_data: "results" },
          ],
          [
            { text: "❓ Help", callback_data: "help" },
          ],
        ],
      },
    }
  );
});

// ===============================
// HELP
// ===============================

bot.onText(/^\/help$/, async (msg) => {
  if (!adminOnly(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `👑 *PrepArena Admin Bot*

Commands:

/addtest - Create a new test
/tests - View all tests
/removetest - Remove a test
/cancel - Cancel current operation

Current features:
• Create tests
• Save tests permanently in Supabase
• View test details
• Manage draft/published tests

Coming next:
• Add questions
• Add options
• Answer keys
• Publish complete tests
• Results & leaderboard`,
    { parse_mode: "Markdown" }
  );
});

// ===============================
// CREATE TEST
// ===============================

bot.onText(/^\/addtest$/, async (msg) => {
  if (!adminOnly(msg)) return;

  addTestSessions.set(msg.chat.id, {
    step: "title",
    data: {},
  });

  await bot.sendMessage(
    msg.chat.id,
    "➕ *Create New Test*\n\nEnter the *test title*:",
    { parse_mode: "Markdown" }
  );
});

// ===============================
// HANDLE TEST CREATION INPUT
// ===============================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  // Ignore commands
  if (msg.text.startsWith("/")) return;

  // Only process active admin test creation session
  if (!isAdmin(msg)) return;

  const session = addTestSessions.get(msg.chat.id);

  if (!session) return;

  const value = msg.text.trim();

  // -------------------------------
  // TITLE
  // -------------------------------

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

  // -------------------------------
  // DESCRIPTION
  // -------------------------------

  if (session.step === "description") {
    session.data.description =
      value.toLowerCase() === "skip" ? null : value;

    session.step = "exam_type";

    await bot.sendMessage(
      msg.chat.id,
      "🎯 Select exam type:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "JEE", callback_data: "exam_JEE" },
              { text: "NEET", callback_data: "exam_NEET" },
            ],
          ],
        },
      }
    );

    return;
  }

  // -------------------------------
  // DATE
  // -------------------------------

  if (session.step === "date") {
    session.data.test_date = value;
    session.step = "time";

    await bot.sendMessage(
      msg.chat.id,
      "⏰ Enter test time.\n\nExample: `19:30`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // TIME
  // -------------------------------

  if (session.step === "time") {
    session.data.test_time = value;
    session.step = "duration";

    await bot.sendMessage(
      msg.chat.id,
      "⏱ Enter duration in minutes.\n\nExample: `180`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // DURATION
  // -------------------------------

  if (session.step === "duration") {
    const duration = Number(value);

    if (!Number.isInteger(duration) || duration <= 0) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Please enter a valid duration in minutes.\n\nExample: `180`"
      );
      return;
    }

    session.data.duration_minutes = duration;
    session.step = "questions";

    await bot.sendMessage(
      msg.chat.id,
      "🔢 Enter total number of questions.\n\nExample: `30`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // QUESTIONS
  // -------------------------------

  if (session.step === "questions") {
    const questions = Number(value);

    if (!Number.isInteger(questions) || questions < 0) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Please enter a valid number of questions."
      );
      return;
    }

    session.data.total_questions = questions;
    session.step = "marks";

    await bot.sendMessage(
      msg.chat.id,
      "🏆 Enter total marks.\n\nExample: `120`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // TOTAL MARKS
  // -------------------------------

  if (session.step === "marks") {
    const marks = Number(value);

    if (!Number.isInteger(marks) || marks < 0) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Please enter a valid total marks value."
      );
      return;
    }

    session.data.total_marks = marks;

    await saveTest(msg.chat.id, session.data);

    addTestSessions.delete(msg.chat.id);

    return;
  }
});

// ===============================
// EXAM TYPE CALLBACK
// ===============================

bot.on("callback_query", async (query) => {
  const msg = query.message;

  if (!msg) return;

  if (query.from.id !== ADMIN_ID) {
    await bot.answerCallbackQuery(query.id, {
      text: "⛔ Unauthorized",
      show_alert: true,
    });

    return;
  }

  const data = query.data;

  // -------------------------------
  // CREATE TEST
  // -------------------------------

  if (data === "create_test") {
    await bot.answerCallbackQuery(query.id);

    addTestSessions.set(msg.chat.id, {
      step: "title",
      data: {},
    });

    await bot.sendMessage(
      msg.chat.id,
      "➕ *Create New Test*\n\nEnter the *test title*:",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // EXAM TYPE
  // -------------------------------

  if (data === "exam_JEE" || data === "exam_NEET") {
    await bot.answerCallbackQuery(query.id);

    const session = addTestSessions.get(msg.chat.id);

    if (!session) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ No active test creation session.\nUse /addtest."
      );
      return;
    }

    const examType = data === "exam_JEE" ? "JEE" : "NEET";

    session.data.exam_type = examType;
    session.step = "date";

    await bot.sendMessage(
      msg.chat.id,
      "📅 Enter test date.\n\nFormat: `YYYY-MM-DD`\nExample: `2026-09-15`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // MANAGE TESTS
  // -------------------------------

  if (data === "manage_tests") {
    await bot.answerCallbackQuery(query.id);
    await showTests(msg.chat.id);
    return;
  }

  // -------------------------------
  // RESULTS
  // -------------------------------

  if (data === "results") {
    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      msg.chat.id,
      "🏆 *Results*\n\nResults management will be connected after the test-taking and scoring system is completed.",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // HELP
  // -------------------------------

  if (data === "help") {
    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      msg.chat.id,
      `👑 *Admin Help*

/addtest → Create test
/tests → View tests
/removetest → Remove test
/cancel → Cancel current operation

Questions and answer keys will be added in the next phase.`,
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // VIEW TEST
  // -------------------------------

  if (data.startsWith("view_test_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("view_test_", "");

    await showTestDetails(msg.chat.id, testId);

    return;
  }

  // -------------------------------
  // BACK TO TESTS
  // -------------------------------

  if (data === "back_tests") {
    await bot.answerCallbackQuery(query.id);
    await showTests(msg.chat.id);
    return;
  }

  // -------------------------------
  // ADD QUESTIONS PLACEHOLDER
  // -------------------------------

  if (data.startsWith("add_questions_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("add_questions_", "");

    await bot.sendMessage(
      msg.chat.id,
      `📝 Question Editor

Test ID:
${testId}

Question creation will be connected to the questions table in the next step.`
    );

    return;
  }

  // -------------------------------
  // PUBLISH
  // -------------------------------

  if (data.startsWith("publish_test_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("publish_test_", "");

    await publishTest(msg.chat.id, testId);

    return;
  }
});

// ===============================
// SAVE TEST TO SUPABASE
// ===============================

async function saveTest(chatId, data) {
  try {
    const testCode = generateTestCode();

    const { data: test, error } = await supabase
      .from("tests")
      .insert({
        title: data.title,
        description: data.description,
        exam_type: data.exam_type,
        test_code: testCode,
        status: "draft",
        test_date: data.test_date,
        test_time: data.test_time,
        duration_minutes: data.duration_minutes,
        total_questions: data.total_questions,
        total_marks: data.total_marks,
        marks_per_question:
          data.total_questions > 0
            ? data.total_marks / data.total_questions
            : 4,
        negative_marking_enabled: true,
        negative_marking_value: 1,
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase test creation error:", error);

      await bot.sendMessage(
        chatId,
        `❌ *Database Error*

${error.message}`,
        { parse_mode: "Markdown" }
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `✅ *Test Created Successfully!*

📚 *Title:* ${test.title}
🎯 *Exam:* ${test.exam_type}
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
                callback_data: `add_questions_${test.id}`,
              },
            ],
          ],
        },
      }
    );
  } catch (error) {
    console.error("Unexpected saveTest error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while creating the test."
    );
  }
}

// ===============================
// GENERATE TEST CODE
// ===============================

function generateTestCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "PA-";

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

// ===============================
// SHOW ALL TESTS
// ===============================

async function showTests(chatId) {
  try {
    const { data: tests, error } = await supabase
      .from("tests")
      .select(
        "id,title,exam_type,test_date,test_time,duration_minutes,total_questions,total_marks,status,test_code"
      )
      .order("created_at", {
        ascending: false,
      });

    if (error) {
      console.error("Fetch tests error:", error);

      await bot.sendMessage(
        chatId,
        `❌ Database Error:\n${error.message}`
      );

      return;
    }

    if (!tests || tests.length === 0) {
      await bot.sendMessage(
        chatId,
        "📚 *Manage Tests*\n\nNo tests found.\n\nUse /addtest to create one.",
        { parse_mode: "Markdown" }
      );

      return;
    }

    const buttons = tests.map((test) => [
      {
        text: `${test.status === "published" ? "🟢" : "🟡"} ${test.title}`,
        callback_data: `view_test_${test.id}`,
      },
    ]);

    await bot.sendMessage(
      chatId,
      `📚 *Manage Tests*\n\nTotal tests: ${tests.length}\n\nSelect a test:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );
  } catch (error) {
    console.error(error);

    await bot.sendMessage(
      chatId,
      "❌ Unable to load tests."
    );
  }
}

// ===============================
// SHOW TEST DETAILS
// ===============================

async function showTestDetails(chatId, testId) {
  try {
    const { data: test, error } = await supabase
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

    const statusIcon =
      test.status === "published"
        ? "🟢"
        : test.status === "ended"
        ? "🔴"
        : "🟡";

    const buttons = [
      [
        {
          text: "📝 Add Questions",
          callback_data: `add_questions_${test.id}`,
        },
      ],
    ];

    if (test.status === "draft") {
      buttons.push([
        {
          text: "🚀 Publish Test",
          callback_data: `publish_test_${test.id}`,
        },
      ]);
    }

    buttons.push([
      {
        text: "⬅️ Back",
        callback_data: "back_tests",
      },
    ]);

    await bot.sendMessage(
      chatId,
      `📚 *Test Details*

*${test.title}*

🎯 Exam: ${test.exam_type}
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
  } catch (error) {
    console.error("showTestDetails error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Unable to load test details."
    );
  }
}

// ===============================
// PUBLISH TEST
// ===============================

async function publishTest(chatId, testId) {
  try {
    const { data: test, error: fetchError } = await supabase
      .from("tests")
      .select("id,title,total_questions")
      .eq("id", testId)
      .single();

    if (fetchError || !test) {
      await bot.sendMessage(
        chatId,
        "❌ Test not found."
      );

      return;
    }

    if (test.total_questions <= 0) {
      await bot.sendMessage(
        chatId,
        "⚠️ This test has 0 questions.\n\nAdd questions before publishing."
      );

      return;
    }

    const { error } = await supabase
      .from("tests")
      .update({
        status: "published",
        updated_at: new Date().toISOString(),
      })
      .eq("id", testId);

    if (error) {
      console.error("Publish error:", error);

      await bot.sendMessage(
        chatId,
        `❌ Unable to publish test.\n\n${error.message}`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `🚀 *Test Published!*

📚 ${test.title}

Students can now see this test in the Student Bot.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("publishTest error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while publishing."
    );
  }
}

// ===============================
// VIEW TESTS COMMAND
// ===============================

bot.onText(/^\/tests$/, async (msg) => {
  if (!adminOnly(msg)) return;

  await showTests(msg.chat.id);
});

// ===============================
// REMOVE TEST
// ===============================

bot.onText(/^\/removetest$/, async (msg) => {
  if (!adminOnly(msg)) return;

  try {
    const { data: tests, error } = await supabase
      .from("tests")
      .select("id,title,test_date")
      .order("created_at", {
        ascending: false,
      });

    if (error) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Database Error:\n${error.message}`
      );
      return;
    }

    if (!tests || tests.length === 0) {
      await bot.sendMessage(
        msg.chat.id,
        "No tests available to remove."
      );
      return;
    }

    const buttons = tests.map((test) => [
      {
        text: `🗑 ${test.title} • ${test.test_date || "No date"}`,
        callback_data: `remove_test_${test.id}`,
      },
    ]);

    await bot.sendMessage(
      msg.chat.id,
      "🗑 *Remove Test*\n\nSelect a test to permanently delete:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );
  } catch (error) {
    console.error(error);

    await bot.sendMessage(
      msg.chat.id,
      "❌ Unable to load tests."
    );
  }
});

// ===============================
// REMOVE TEST CALLBACK
// ===============================

bot.on("callback_query", async (query) => {
  const msg = query.message;

  if (!msg) return;

  if (query.from.id !== ADMIN_ID) return;

  const data = query.data;

  if (!data.startsWith("remove_test_")) return;

  await bot.answerCallbackQuery(query.id);

  const testId = data.replace("remove_test_", "");

  try {
    const { data: test, error: fetchError } = await supabase
      .from("tests")
      .select("title")
      .eq("id", testId)
      .single();

    if (fetchError || !test) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Test not found."
      );
      return;
    }

    const { error } = await supabase
      .from("tests")
      .delete()
      .eq("id", testId);

    if (error) {
      console.error("Delete error:", error);

      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to delete test.\n\n${error.message}`
      );

      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `🗑 *Test Deleted*

${test.title}

All related questions, options, answer keys, participants, answers and results linked through cascade relationships are also removed.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("remove test error:", error);

    await bot.sendMessage(
      msg.chat.id,
      "❌ Something went wrong while deleting the test."
    );
  }
});

// ===============================
// CANCEL
// ===============================

bot.onText(/^\/cancel$/, async (msg) => {
  if (!adminOnly(msg)) return;

  if (addTestSessions.has(msg.chat.id)) {
    addTestSessions.delete(msg.chat.id);

    await bot.sendMessage(
      msg.chat.id,
      "❌ Current operation cancelled."
    );

    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    "Nothing is currently running."
  );
});

// ===============================
// ERROR HANDLERS
// ===============================

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.message);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

console.log("🚀 PrepArena Admin Bot is running...");
console.log("🗄️ Supabase database connected.");
