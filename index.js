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

// Test creation sessions
const addTestSessions = new Map();

// Subject management sessions
const subjectSessions = new Map();

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
    "👑 *PrepArena Admin Panel*\n\nWelcome Admin!\nManage tests, subjects and prepare them for students.",
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
            { text: "📖 Subjects", callback_data: "subjects_menu" },
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
/subs - Manage subjects
/cancel - Cancel current operation

Current features:
• Create tests
• Save tests permanently in Supabase
• Assign multiple subjects to a test
• Manage subjects
• Validate future test date/time
• View test details
• Manage draft/published tests

Coming next:
• Add questions
• Add options
• Answer keys
• Complete test publishing
• Results & leaderboard`,
    { parse_mode: "Markdown" }
  );
});

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

bot.onText(/^\/addtest$/, async (msg) => {
  if (!adminOnly(msg)) return;

  await startCreateTest(msg.chat.id);
});

// ===============================
// HANDLE TEST CREATION INPUT
// ===============================

bot.on("message", async (msg) => {
  if (!msg.text) return;

  // Ignore commands
  if (msg.text.startsWith("/")) return;

  // Only admin can create/manage
  if (!isAdmin(msg)) return;

  // -------------------------------
  // SUBJECT ADD/EDIT SESSION
  // -------------------------------

  const subjectSession = subjectSessions.get(msg.chat.id);

  if (subjectSession) {
    await handleSubjectInput(msg, subjectSession);
    return;
  }

  // -------------------------------
  // TEST CREATION SESSION
  // -------------------------------

  const session = addTestSessions.get(msg.chat.id);

  if (!session) return;

  const value = msg.text.trim();

  // -------------------------------
  // TITLE
  // -------------------------------

  if (session.step === "title") {
    if (!value) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Test title cannot be empty."
      );
      return;
    }

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

    await showSubjectSelection(msg.chat.id, session);

    return;
  }

  // -------------------------------
  // DATE
  // -------------------------------

  if (session.step === "date") {
    const date = value;

    if (!isValidDateFormat(date)) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Invalid date format.\n\nUse:\n`YYYY-MM-DD`\n\nExample: `2026-09-15`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    session.data.test_date = date;

    session.step = "time";

    await bot.sendMessage(
      msg.chat.id,
      "⏰ Enter test time.\n\nFormat: `HH:MM`\nExample: `19:30`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // -------------------------------
  // TIME
  // -------------------------------

  if (session.step === "time") {
    const time = normalizeTime(value);

    if (!time) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Invalid time.\n\nUse 24-hour format:\n`HH:MM`\n\nExample: `19:30`"
      );
      return;
    }

    const date = session.data.test_date;

    if (!isFutureISTDateTime(date, time)) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ The test date and time must be strictly in the future.\n\nPast date/time, current time, or exact current time is not allowed.\n\nPlease enter the test *date* again:",
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
// CALLBACK HANDLER
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

  // ===============================
  // CREATE TEST
  // ===============================

  if (data === "create_test") {
    await bot.answerCallbackQuery(query.id);

    await startCreateTest(msg.chat.id);

    return;
  }

  // ===============================
  // SUBJECT MENU
  // ===============================

  if (data === "subjects_menu") {
    await bot.answerCallbackQuery(query.id);

    await showSubjectsMenu(msg.chat.id);

    return;
  }

  // ===============================
  // ADD SUBJECT
  // ===============================

  if (data === "subject_add") {
    await bot.answerCallbackQuery(query.id);

    subjectSessions.set(msg.chat.id, {
      step: "add",
      data: {},
    });

    await bot.sendMessage(
      msg.chat.id,
      "➕ *Add Subject*\n\nEnter the subject name:",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // ===============================
  // VIEW SUBJECTS
  // ===============================

  if (data === "subject_list") {
    await bot.answerCallbackQuery(query.id);

    await showSubjectsList(msg.chat.id);

    return;
  }

  // ===============================
  // EDIT SUBJECT
  // ===============================

  if (data.startsWith("edit_subject_")) {
    await bot.answerCallbackQuery(query.id);

    const subjectId = data.replace("edit_subject_", "");

    const { data: subject, error } = await supabase
      .from("subjects")
      .select("id,name")
      .eq("id", subjectId)
      .single();

    if (error || !subject) {
      await bot.sendMessage(
        msg.chat.id,
        "❌ Subject not found."
      );
      return;
    }

    subjectSessions.set(msg.chat.id, {
      step: "edit",
      data: {
        subjectId: subject.id,
        oldName: subject.name,
      },
    });

    await bot.sendMessage(
      msg.chat.id,
      `✏️ *Edit Subject*

Current name:
*${subject.name}*

Enter the new subject name:`,
      { parse_mode: "Markdown" }
    );

    return;
  }

  // ===============================
  // REMOVE SUBJECT
  // ===============================

  if (data.startsWith("remove_subject_")) {
    await bot.answerCallbackQuery(query.id);

    const subjectId = data.replace("remove_subject_", "");

    await removeSubject(msg.chat.id, subjectId);

    return;
  }

  // ===============================
  // SUBJECT SELECTION FOR TEST
  // ===============================

  if (data.startsWith("test_subject_")) {
    await bot.answerCallbackQuery(query.id);

    const subjectId = data.replace("test_subject_", "");

    const session = addTestSessions.get(msg.chat.id);

    if (!session || session.step !== "subjects") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ No active test creation session."
      );
      return;
    }

    const selected = session.data.subjectIds || [];

    if (selected.includes(subjectId)) {
      session.data.subjectIds = selected.filter(
        (id) => id !== subjectId
      );
    } else {
      session.data.subjectIds = [...selected, subjectId];
    }

    await showSubjectSelection(msg.chat.id, session, true);

    return;
  }

  // ===============================
  // FINISH SUBJECT SELECTION
  // ===============================

  if (data === "test_subject_done") {
    await bot.answerCallbackQuery(query.id);

    const session = addTestSessions.get(msg.chat.id);

    if (!session || session.step !== "subjects") {
      await bot.sendMessage(
        msg.chat.id,
        "❌ No active test creation session."
      );
      return;
    }

    if (!session.data.subjectIds || session.data.subjectIds.length === 0) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Please select at least one subject before continuing."
      );
      return;
    }

    session.step = "date";

    await bot.sendMessage(
      msg.chat.id,
      "📅 Enter test date.\n\nFormat: `YYYY-MM-DD`\nExample: `2026-09-15`",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // ===============================
  // MANAGE TESTS
  // ===============================

  if (data === "manage_tests") {
    await bot.answerCallbackQuery(query.id);

    await showTests(msg.chat.id);

    return;
  }

  // ===============================
  // RESULTS
  // ===============================

  if (data === "results") {
    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      msg.chat.id,
      "🏆 *Results*\n\nResults management will be connected after the test-taking and scoring system is completed.",
      { parse_mode: "Markdown" }
    );

    return;
  }

  // ===============================
  // HELP
  // ===============================

  if (data === "help") {
    await bot.answerCallbackQuery(query.id);

    await bot.sendMessage(
      msg.chat.id,
      `👑 *Admin Help*

/addtest → Create test
/tests → View tests
/removetest → Remove test
/subs → Manage subjects
/cancel → Cancel current operation

Questions and answer keys will be added in the next phase.`,
      { parse_mode: "Markdown" }
    );

    return;
  }

  // ===============================
  // VIEW TEST
  // ===============================

  if (data.startsWith("view_test_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("view_test_", "");

    await showTestDetails(msg.chat.id, testId);

    return;
  }

  // ===============================
  // BACK TO TESTS
  // ===============================

  if (data === "back_tests") {
    await bot.answerCallbackQuery(query.id);

    await showTests(msg.chat.id);

    return;
  }

  // ===============================
  // ADD QUESTIONS PLACEHOLDER
  // ===============================

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

  // ===============================
  // PUBLISH
  // ===============================

  if (data.startsWith("publish_test_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("publish_test_", "");

    await publishTest(msg.chat.id, testId);

    return;
  }

  // ===============================
  // REMOVE TEST
  // ===============================

  if (data.startsWith("remove_test_")) {
    await bot.answerCallbackQuery(query.id);

    const testId = data.replace("remove_test_", "");

    await removeTest(msg.chat.id, testId);

    return;
  }
});

// ===============================
// SUBJECT MENU
// ===============================

async function showSubjectsMenu(chatId) {
  await bot.sendMessage(
    chatId,
    "📖 *Subject Management*\n\nManage the reusable subject list for your tests.",
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
// SHOW SUBJECT LIST
// ===============================

async function showSubjectsList(chatId) {
  try {
    const { data: subjects, error } = await supabase
      .from("subjects")
      .select("id,name,is_active")
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("Subjects fetch error:", error);

      await bot.sendMessage(
        chatId,
        `❌ Database Error:\n${error.message}`
      );

      return;
    }

    if (!subjects || subjects.length === 0) {
      await bot.sendMessage(
        chatId,
        "📖 No subjects found.\n\nUse Add Subject to create one."
      );

      return;
    }

    const buttons = subjects.map((subject) => [
      {
        text: `✏️ ${subject.name}`,
        callback_data: `edit_subject_${subject.id}`,
      },
      {
        text: "🗑",
        callback_data: `remove_subject_${subject.id}`,
      },
    ]);

    await bot.sendMessage(
      chatId,
      `📖 *Available Subjects*\n\nTotal: ${subjects.length}\n\nTap a subject to edit or remove it.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );
  } catch (error) {
    console.error("showSubjectsList error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Unable to load subjects."
    );
  }
}

// ===============================
// HANDLE SUBJECT INPUT
// ===============================

async function handleSubjectInput(msg, session) {
  const value = msg.text.trim();

  if (!value) {
    await bot.sendMessage(
      msg.chat.id,
      "❌ Subject name cannot be empty."
    );
    return;
  }

  // -------------------------------
  // ADD
  // -------------------------------

  if (session.step === "add") {
    const { data: existing } = await supabase
      .from("subjects")
      .select("id")
      .ilike("name", value)
      .limit(1);

    if (existing && existing.length > 0) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ This subject already exists."
      );
      return;
    }

    const { data, error } = await supabase
      .from("subjects")
      .insert({
        name: value,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("Add subject error:", error);

      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to add subject.\n\n${error.message}`
      );

      return;
    }

    subjectSessions.delete(msg.chat.id);

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Subject Added!*

📖 ${data.name}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📖 Manage Subjects",
                callback_data: "subjects_menu",
              },
            ],
          ],
        },
      }
    );

    return;
  }

  // -------------------------------
  // EDIT
  // -------------------------------

  if (session.step === "edit") {
    const subjectId = session.data.subjectId;

    const { data: existing } = await supabase
      .from("subjects")
      .select("id")
      .ilike("name", value)
      .neq("id", subjectId)
      .limit(1);

    if (existing && existing.length > 0) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Another subject with this name already exists."
      );
      return;
    }

    const { data, error } = await supabase
      .from("subjects")
      .update({
        name: value,
      })
      .eq("id", subjectId)
      .select()
      .single();

    if (error) {
      console.error("Edit subject error:", error);

      await bot.sendMessage(
        msg.chat.id,
        `❌ Unable to edit subject.\n\n${error.message}`
      );

      return;
    }

    subjectSessions.delete(msg.chat.id);

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Subject Updated!*

📖 ${data.name}`,
      { parse_mode: "Markdown" }
    );

    return;
  }
}

// ===============================
// REMOVE SUBJECT
// ===============================

async function removeSubject(chatId, subjectId) {
  try {
    const { data: subject, error: fetchError } = await supabase
      .from("subjects")
      .select("id,name")
      .eq("id", subjectId)
      .single();

    if (fetchError || !subject) {
      await bot.sendMessage(
        chatId,
        "❌ Subject not found."
      );
      return;
    }

    // Soft delete so existing test-subject relationships remain safe
    const { error } = await supabase
      .from("subjects")
      .update({
        is_active: false,
      })
      .eq("id", subjectId);

    if (error) {
      console.error("Remove subject error:", error);

      await bot.sendMessage(
        chatId,
        `❌ Unable to remove subject.\n\n${error.message}`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `🗑 *Subject Removed*

📖 ${subject.name}

Existing tests using this subject are not deleted.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("removeSubject error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while removing the subject."
    );
  }
}

// ===============================
// SUBJECT SELECTION FOR TEST
// ===============================

async function showSubjectSelection(chatId, session, editMessage = false) {
  const { data: subjects, error } = await supabase
    .from("subjects")
    .select("id,name,is_active")
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) {
    console.error("Subject selection error:", error);

    await bot.sendMessage(
      chatId,
      `❌ Unable to load subjects.\n\n${error.message}`
    );

    return;
  }

  if (!subjects || subjects.length === 0) {
    await bot.sendMessage(
      chatId,
      "❌ No active subjects are available.\n\nUse /subs to add subjects first."
    );

    return;
  }

  session.step = "subjects";

  const selected = session.data.subjectIds || [];

  const buttons = subjects.map((subject) => {
    const isSelected = selected.includes(subject.id);

    return [
      {
        text: `${isSelected ? "☑️" : "⬜"} ${subject.name}`,
        callback_data: `test_subject_${subject.id}`,
      },
    ];
  });

  buttons.push([
    {
      text: "✅ Done",
      callback_data: "test_subject_done",
    },
  ]);

  await bot.sendMessage(
    chatId,
    `📚 *Select Test Subjects*

Select one or multiple subjects:

Selected: *${selected.length}*

Tap the subjects and then press *Done*.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ===============================
// SAVE TEST
// ===============================

async function saveTest(chatId, data) {
  try {
    const testCode = generateTestCode();

    const { data: test, error } = await supabase
      .from("tests")
      .insert({
        title: data.title,
        description: data.description,
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

    // Link selected subjects to test
    const subjectIds = data.subjectIds || [];

    if (subjectIds.length > 0) {
      const relations = subjectIds.map((subjectId) => ({
        test_id: test.id,
        subject_id: subjectId,
      }));

      const { error: relationError } = await supabase
        .from("test_subjects")
        .insert(relations);

      if (relationError) {
        console.error(
          "Test-subject relation error:",
          relationError
        );

        // Roll back the test if subject linking fails
        await supabase
          .from("tests")
          .delete()
          .eq("id", test.id);

        await bot.sendMessage(
          chatId,
          `❌ Could not connect subjects to the test.\n\n${relationError.message}`
        );

        return;
      }
    }

    const subjectsText = await getTestSubjectsText(test.id);

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
// GET TEST SUBJECTS
// ===============================

async function getTestSubjectsText(testId) {
  try {
    const { data, error } = await supabase
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

    if (error || !data || data.length === 0) {
      return "None";
    }

    return data
      .map((item) => item.subjects?.name)
      .filter(Boolean)
      .join(", ") || "None";
  } catch (error) {
    console.error("getTestSubjectsText error:", error);
    return "None";
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
// DATE VALIDATION
// ===============================

function isValidDateFormat(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// ===============================
// TIME NORMALIZATION
// ===============================

function normalizeTime(value) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(
    minute
  ).padStart(2, "0")}`;
}

// ===============================
// STRICT FUTURE IST CHECK
// ===============================

function isFutureISTDateTime(dateString, timeString) {
  if (!isValidDateFormat(dateString)) return false;

  const normalizedTime = normalizeTime(timeString);

  if (!normalizedTime) return false;

  const [year, month, day] = dateString
    .split("-")
    .map(Number);

  const [hour, minute] = normalizedTime
    .split(":")
    .map(Number);

  // India Standard Time = UTC+05:30
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
// SHOW ALL TESTS
// ===============================

async function showTests(chatId) {
  try {
    const { data: tests, error } = await supabase
      .from("tests")
      .select(
        "id,title,test_date,test_time,duration_minutes,total_questions,total_marks,status,test_code"
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

    const subjectsText = await getTestSubjectsText(test.id);

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
// REMOVE TEST COMMAND
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
// REMOVE TEST
// ===============================

async function removeTest(chatId, testId) {
  try {
    const { data: test, error: fetchError } = await supabase
      .from("tests")
      .select("title")
      .eq("id", testId)
      .single();

    if (fetchError || !test) {
      await bot.sendMessage(
        chatId,
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
        chatId,
        `❌ Unable to delete test.\n\n${error.message}`
      );

      return;
    }

    await bot.sendMessage(
      chatId,
      `🗑 *Test Deleted*

${test.title}

All related questions, options, answer keys, participants, answers and results linked through cascade relationships are also removed.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("remove test error:", error);

    await bot.sendMessage(
      chatId,
      "❌ Something went wrong while deleting the test."
    );
  }
}

// ===============================
// CANCEL
// ===============================

bot.onText(/^\/cancel$/, async (msg) => {
  if (!adminOnly(msg)) return;

  let cancelled = false;

  if (addTestSessions.has(msg.chat.id)) {
    addTestSessions.delete(msg.chat.id);
    cancelled = true;
  }

  if (subjectSessions.has(msg.chat.id)) {
    subjectSessions.delete(msg.chat.id);
    cancelled = true;
  }

  if (cancelled) {
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
// SHORT COMMAND FOR SUBJECTS
// ===============================

bot.onText(/^\/subs$/, async (msg) => {
  if (!adminOnly(msg)) return;

  await showSubjectsMenu(msg.chat.id);
});

// ===============================
// ERROR HANDLERS
// ===============================

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

process.on("unhandledRejection", (error) => {
  console.error(
    "Unhandled rejection:",
    error
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    "Uncaught exception:",
    error
  );
});

console.log("🚀 PrepArena Admin Bot is running...");
console.log("🗄️ Supabase database connected.");
