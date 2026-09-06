const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is not configured");
}

const bot = new TelegramBot(token, { polling: true });

// ===============================
// ADMIN CONFIG
// ===============================

const ADMIN_ID = 8256722518;

// Temporary test storage
// Database will be connected in the next phase.
const tests = [];

// Stores users currently creating a test
const addTestSessions = new Map();

// ===============================
// ACCESS CONTROL
// ===============================

function isAdmin(msg) {
  return msg.from && msg.from.id === ADMIN_ID;
}

function denyAccess(msg) {
  bot.sendMessage(
    msg.chat.id,
    "⛔ Access denied.\n\nThis bot is only for PrepArena administrators."
  );
}

// ===============================
// /START
// ===============================

bot.onText(/^\/start$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ Create Test", callback_data: "create_test" },
        { text: "📋 Manage Tests", callback_data: "manage_tests" }
      ],
      [
        { text: "📊 Results", callback_data: "results" }
      ],
      [
        { text: "ℹ️ Help", callback_data: "help" }
      ]
    ]
  };

  bot.sendMessage(
    msg.chat.id,
    `👑 *PrepArena Admin Panel*

Welcome Admin.

Use this bot to create and manage PrepArena tests.`,
    {
      parse_mode: "Markdown",
      reply_markup: keyboard
    }
  );
});

// ===============================
// /HELP
// ===============================

bot.onText(/^\/help$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  bot.sendMessage(
    msg.chat.id,
    `👑 *Admin Bot Commands*

/start — Open Admin Panel
/addtest — Create a new test
/tests — View all tests
/removetest — Remove a test
/cancel — Cancel current operation

More features will be added:
• Add questions
• Add answer keys
• Publish tests
• View results
• Leaderboards`,
    { parse_mode: "Markdown" }
  );
});

// ===============================
// CREATE TEST
// ===============================

function startCreateTest(chatId) {
  addTestSessions.set(chatId, {
    step: "title",
    data: {}
  });

  bot.sendMessage(
    chatId,
    "📝 *Create New Test*\n\nStep 1/6\n\nEnter the *test title*:",
    { parse_mode: "Markdown" }
  );
}

bot.onText(/^\/addtest$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  startCreateTest(msg.chat.id);
});

// ===============================
// TEXT INPUT HANDLER
// ===============================

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isAdmin(msg)) return;

  // Ignore commands
  if (msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const session = addTestSessions.get(chatId);

  if (!session) return;

  const value = msg.text.trim();

  // TITLE
  if (session.step === "title") {
    session.data.title = value;
    session.step = "date";

    return bot.sendMessage(
      chatId,
      "📅 *Step 2/6*\n\nEnter test date:\n\nExample: `15 September 2026`",
      { parse_mode: "Markdown" }
    );
  }

  // DATE
  if (session.step === "date") {
    session.data.date = value;
    session.step = "time";

    return bot.sendMessage(
      chatId,
      "⏰ *Step 3/6*\n\nEnter test time:\n\nExample: `7:00 PM`",
      { parse_mode: "Markdown" }
    );
  }

  // TIME
  if (session.step === "time") {
    session.data.time = value;
    session.step = "duration";

    return bot.sendMessage(
      chatId,
      "⏱️ *Step 4/6*\n\nEnter test duration in minutes:\n\nExample: `180`",
      { parse_mode: "Markdown" }
    );
  }

  // DURATION
  if (session.step === "duration") {
    const duration = Number(value);

    if (!Number.isInteger(duration) || duration <= 0) {
      return bot.sendMessage(
        chatId,
        "❌ Please enter a valid duration in minutes.\n\nExample: `180`"
      );
    }

    session.data.duration = duration;
    session.step = "questions";

    return bot.sendMessage(
      chatId,
      "❓ *Step 5/6*\n\nEnter number of questions:\n\nExample: `75`",
      { parse_mode: "Markdown" }
    );
  }

  // QUESTIONS
  if (session.step === "questions") {
    const questions = Number(value);

    if (!Number.isInteger(questions) || questions <= 0) {
      return bot.sendMessage(
        chatId,
        "❌ Please enter a valid number of questions."
      );
    }

    session.data.questions = questions;
    session.step = "marks";

    return bot.sendMessage(
      chatId,
      "🎯 *Step 6/6*\n\nEnter total marks:\n\nExample: `300`",
      { parse_mode: "Markdown" }
    );
  }

  // MARKS
  if (session.step === "marks") {
    const marks = Number(value);

    if (!Number.isInteger(marks) || marks <= 0) {
      return bot.sendMessage(
        chatId,
        "❌ Please enter a valid total marks value."
      );
    }

    session.data.marks = marks;

    const test = {
      id: Date.now().toString(),
      title: session.data.title,
      date: session.data.date,
      time: session.data.time,
      duration: session.data.duration,
      questions: session.data.questions,
      marks: session.data.marks,
      status: "draft",
      createdAt: new Date().toISOString()
    };

    tests.push(test);

    addTestSessions.delete(chatId);

    return bot.sendMessage(
      chatId,
      `✅ *Test Created Successfully!*

📝 ${test.title}
📅 ${test.date}
⏰ ${test.time}
⏱️ ${test.duration} minutes
❓ ${test.questions} questions
🎯 ${test.marks} marks

Status: 🟡 Draft

Next phase:
Add questions and answer keys.`,
      { parse_mode: "Markdown" }
    );
  }
});

// ===============================
// VIEW TESTS
// ===============================

bot.onText(/^\/tests$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  if (tests.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      "📋 No tests created yet.\n\nUse /addtest to create one."
    );
  }

  const buttons = tests.map((test) => [
    {
      text: `📝 ${test.title} • 📅 ${test.date}`,
      callback_data: `view_test_${test.id}`
    }
  ]);

  bot.sendMessage(
    msg.chat.id,
    "📋 *PrepArena Tests*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

// ===============================
// REMOVE TEST
// ===============================

bot.onText(/^\/removetest$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  if (tests.length === 0) {
    return bot.sendMessage(msg.chat.id, "There are no tests to remove.");
  }

  const buttons = tests.map((test) => [
    {
      text: `🗑️ ${test.title}`,
      callback_data: `remove_test_${test.id}`
    }
  ]);

  bot.sendMessage(
    msg.chat.id,
    "🗑️ Select the test you want to remove:",
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
});

// ===============================
// CANCEL
// ===============================

bot.onText(/^\/cancel$/, (msg) => {
  if (!isAdmin(msg)) {
    return denyAccess(msg);
  }

  if (addTestSessions.has(msg.chat.id)) {
    addTestSessions.delete(msg.chat.id);

    return bot.sendMessage(
      msg.chat.id,
      "❌ Current operation cancelled."
    );
  }

  bot.sendMessage(msg.chat.id, "Nothing to cancel.");
});

// ===============================
// CALLBACK BUTTONS
// ===============================

bot.on("callback_query", async (query) => {
  const msg = query.message;
  const data = query.data;

  if (!query.from || query.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(query.id, {
      text: "⛔ Access denied."
    });
  }

  await bot.answerCallbackQuery(query.id);

  // CREATE TEST
  if (data === "create_test") {
    return startCreateTest(msg.chat.id);
  }

  // MANAGE TESTS
  if (data === "manage_tests") {
    if (tests.length === 0) {
      return bot.sendMessage(
        msg.chat.id,
        "📋 No tests created yet."
      );
    }

    const buttons = tests.map((test) => [
      {
        text: `📝 ${test.title} • ${test.date}`,
        callback_data: `view_test_${test.id}`
      }
    ]);

    return bot.sendMessage(
      msg.chat.id,
      "📋 *Manage Tests*",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons
        }
      }
    );
  }

  // RESULTS
  if (data === "results") {
    return bot.sendMessage(
      msg.chat.id,
      "📊 Results management will be connected after the shared database and student test engine are ready."
    );
  }

  // HELP
  if (data === "help") {
    return bot.sendMessage(
      msg.chat.id,
      `👑 *Admin Bot*

Create and manage PrepArena tests from Telegram.

Use /addtest to create a test.`,
      { parse_mode: "Markdown" }
    );
  }

  // VIEW TEST
  if (data.startsWith("view_test_")) {
    const id = data.replace("view_test_", "");
    const test = tests.find((t) => t.id === id);

    if (!test) {
      return bot.sendMessage(msg.chat.id, "❌ Test not found.");
    }

    return bot.sendMessage(
      msg.chat.id,
      `📝 *${test.title}*

📅 Date: ${test.date}
⏰ Time: ${test.time}
⏱️ Duration: ${test.duration} minutes
❓ Questions: ${test.questions}
🎯 Total Marks: ${test.marks}

📌 Status: ${test.status === "draft" ? "🟡 Draft" : "🟢 Published"}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "❓ Add Questions",
                callback_data: `add_questions_${test.id}`
              }
            ],
            [
              {
                text: "📢 Publish Test",
                callback_data: `publish_test_${test.id}`
              }
            ]
          ]
        }
      }
    );
  }

  // ADD QUESTIONS
  if (data.startsWith("add_questions_")) {
    return bot.sendMessage(
      msg.chat.id,
      "❓ Question editor will be added in the next phase."
    );
  }

  // PUBLISH
  if (data.startsWith("publish_test_")) {
    const id = data.replace("publish_test_", "");
    const test = tests.find((t) => t.id === id);

    if (!test) {
      return bot.sendMessage(msg.chat.id, "❌ Test not found.");
    }

    test.status = "published";

    return bot.sendMessage(
      msg.chat.id,
      `📢 *Test Published!*

📝 ${test.title}

⚠️ Currently this publication is only stored temporarily.

Shared database integration will make this test visible to the Student Bot.`,
      { parse_mode: "Markdown" }
    );
  }

  // REMOVE TEST
  if (data.startsWith("remove_test_")) {
    const id = data.replace("remove_test_", "");

    const index = tests.findIndex((t) => t.id === id);

    if (index === -1) {
      return bot.sendMessage(msg.chat.id, "❌ Test not found.");
    }

    const removed = tests.splice(index, 1)[0];

    return bot.sendMessage(
      msg.chat.id,
      `🗑️ Test removed successfully.\n\n📝 ${removed.title}`
    );
  }
});

// ===============================
// ERROR HANDLING
// ===============================

bot.on("polling_error", (error) => {
  console.error("Polling error:", error.message);
});

console.log("👑 PrepArena Admin Bot is running...");
