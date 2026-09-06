const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// ============================================================
// ENVIRONMENT
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is missing");
if (!SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
if (!OWNER_PASSWORD) throw new Error("OWNER_PASSWORD is missing");

const OWNER_ID = 8256722518;

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
});

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ============================================================
// SESSIONS
// ============================================================

const addTestSessions = new Map();
const subjectSessions = new Map();
const authSessions = new Map();
const adminSessions = new Map();
const questionSessions = new Map();

// ============================================================
// PASSWORD HELPERS
// ============================================================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);

  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  try {
    const parts = storedHash.split(":");

    if (parts.length !== 3) return false;

    const [, salt, keyHex] = parts;

    const storedKey = Buffer.from(keyHex, "hex");
    const derivedKey = crypto.scryptSync(
      password,
      salt,
      storedKey.length
    );

    return crypto.timingSafeEqual(storedKey, derivedKey);
  } catch (error) {
    console.error("Password verification error:", error);
    return false;
  }
}

// ============================================================
// OWNER ACCOUNT
// ============================================================

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
    if (data.role !== "owner" || data.is_active !== true) {
      const { error: updateError } = await supabase
        .from("telegram_admins")
        .update({
          role: "owner",
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq("telegram_user_id", OWNER_ID);

      if (updateError) {
        throw new Error(
          `Unable to repair owner account: ${updateError.message}`
        );
      }
    }

    return;
  }

  const passwordHash = hashPassword(OWNER_PASSWORD);

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
// ADMIN HELPERS
// ============================================================

async function getAdmin(telegramUserId) {
  const { data, error } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id, role, password_hash, is_active"
    )
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (error) {
    console.error("getAdmin error:", error);
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

// ============================================================
// TELEGRAM HELPERS
// ============================================================

async function tryDeleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) {
    // Ignore delete failures.
  }
}

async function safeSend(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error("sendMessage error:", error);
    return null;
  }
}

// ============================================================
// AUTHENTICATION
// ============================================================

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

  await safeSend(
    chatId,
    "🔐 *Admin Authentication Required*\n\nEnter your admin password:",
    {
      parse_mode: "Markdown",
    }
  );
}

async function requireAuth(msg, action) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  const admin = await getAdmin(telegramUserId);

  if (!admin) {
    await safeSend(
      chatId,
      "❌ You are not authorized to use the PrepArena Admin Bot."
    );

    return false;
  }

  await requestPassword(
    chatId,
    telegramUserId,
    action
  );

  return true;
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
              callback_data: "create_test",
            },
            {
              text: "📋 Manage Tests",
              callback_data: "manage_tests",
            },
          ],
          [
            {
              text: "📚 Subjects",
              callback_data: "subjects_menu",
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
    `📖 *PrepArena Admin Help*

*Test Management*
• Create tests
• Select subjects
• Add questions
• Edit questions
• Delete questions
• Publish tests
• End tests

*Question Builder*
• MCQ
• Multiple Correct
• Numerical
• Custom marks
• Custom negative marks
• Automatic question numbering

*Answer Key*
Answer keys are added *after the test ends*.

*Admin Management*
• Owner can add admins
• Owner can remove admins
• Admin passwords are stored securely

*Commands*
/start
/help
/addtest
/tests
/removetest
/subs
/admins
/cancel`,
    {
      parse_mode: "Markdown",
    }
  );
}

// ============================================================
// CANCEL
// ============================================================

function cancelSessions(chatId) {
  addTestSessions.delete(chatId);
  subjectSessions.delete(chatId);
  adminSessions.delete(chatId);
  questionSessions.delete(chatId);
  authSessions.delete(chatId);
}

// ============================================================
// CALLBACK ACTION PARSER
// ============================================================

function parseCallbackAction(data) {
  const simpleActions = [
    "create_test",
    "subjects_menu",
    "subject_add",
    "subject_list",
    "manage_tests",
    "results",
    "help",
    "back_tests",
    "admins",
    "add_admin",
    "remove_admin",
    "test_subject_done",
  ];

  if (simpleActions.includes(data)) {
    return { type: data };
  }

  if (data.startsWith("edit_subject_")) {
    return {
      type: "edit_subject",
      subjectId: data.slice("edit_subject_".length),
    };
  }

  if (data.startsWith("remove_subject_")) {
    return {
      type: "remove_subject",
      subjectId: data.slice("remove_subject_".length),
    };
  }

  if (data.startsWith("test_subject_")) {
    return {
      type: "test_subject",
      testId: data.slice("test_subject_".length),
    };
  }

  if (data.startsWith("view_test_")) {
    return {
      type: "view_test",
      testId: data.slice("view_test_".length),
    };
  }

  if (data.startsWith("add_questions_")) {
    return {
      type: "add_questions",
      testId: data.slice("add_questions_".length),
    };
  }

  if (data.startsWith("publish_test_")) {
    return {
      type: "publish_test",
      testId: data.slice("publish_test_".length),
    };
  }

  if (data.startsWith("remove_test_")) {
    return {
      type: "remove_test",
      testId: data.slice("remove_test_".length),
    };
  }

  if (data.startsWith("end_test_")) {
    return {
      type: "end_test",
      testId: data.slice("end_test_".length),
    };
  }

  if (data.startsWith("answer_key_")) {
    return {
      type: "answer_key",
      testId: data.slice("answer_key_".length),
    };
  }

  if (data.startsWith("remove_admin_")) {
    return {
      type: "remove_admin_selected",
      adminId: Number(
        data.slice("remove_admin_".length)
      ),
    };
  }

  // ============================================================
  // QUESTION BUILDER CALLBACKS
  // ============================================================

  if (data.startsWith("question_add_")) {
    return {
      type: "question_add",
      testId: data.slice("question_add_".length),
    };
  }

  if (data.startsWith("question_view_")) {
    const rest = data.slice("question_view_".length);
    const lastUnderscore = rest.lastIndexOf("_");

    return {
      type: "question_view",
      testId: rest.slice(0, lastUnderscore),
      page: Number(rest.slice(lastUnderscore + 1)),
    };
  }

  if (data.startsWith("question_edit_list_")) {
    const rest = data.slice(
      "question_edit_list_".length
    );

    const lastUnderscore = rest.lastIndexOf("_");

    return {
      type: "question_edit_list",
      testId: rest.slice(0, lastUnderscore),
      page: Number(rest.slice(lastUnderscore + 1)),
    };
  }

  if (data.startsWith("question_delete_list_")) {
    const rest = data.slice(
      "question_delete_list_".length
    );

    const lastUnderscore = rest.lastIndexOf("_");

    return {
      type: "question_delete_list",
      testId: rest.slice(0, lastUnderscore),
      page: Number(rest.slice(lastUnderscore + 1)),
    };
  }

  if (data.startsWith("question_edit_start_")) {
    return {
      type: "question_edit_start",
      questionId: data.slice(
        "question_edit_start_".length
      ),
    };
  }

  if (data.startsWith("question_edit_")) {
    return {
      type: "question_edit",
      questionId: data.slice(
        "question_edit_".length
      ),
    };
  }

  if (data.startsWith("question_delete_confirm_")) {
    return {
      type: "question_delete_confirm",
      questionId: data.slice(
        "question_delete_confirm_".length
      ),
    };
  }

  if (data.startsWith("question_delete_")) {
    return {
      type: "question_delete",
      questionId: data.slice(
        "question_delete_".length
      ),
    };
  }

  if (data.startsWith("question_back_menu_")) {
    return {
      type: "question_back_menu",
      testId: data.slice(
        "question_back_menu_".length
      ),
    };
  }

  if (data.startsWith("question_back_test_")) {
    return {
      type: "question_back_test",
      testId: data.slice(
        "question_back_test_".length
      ),
    };
  }

  if (data.startsWith("question_back_editlist_")) {
    return {
      type: "question_back_editlist",
      testId: data.slice(
        "question_back_editlist_".length
      ),
    };
  }

  if (data.startsWith("question_back_deletelist_")) {
    return {
      type: "question_back_deletelist",
      testId: data.slice(
        "question_back_deletelist_".length
      ),
    };
  }

  if (data.startsWith("question_type_")) {
    const rest = data.slice("question_type_".length);
    const firstUnderscore = rest.indexOf("_");

    if (firstUnderscore === -1) {
      return { type: "unknown" };
    }

    const questionType = rest.slice(
      0,
      firstUnderscore
    );

    const id = rest.slice(firstUnderscore + 1);

    return {
      type: "question_type",
      questionType,
      id,
    };
  }

  return {
    type: "unknown",
  };
}

// ============================================================
// AUTHENTICATED ACTION EXECUTOR
// ============================================================

async function executeAuthenticatedAction(
  chatId,
  telegramUserId,
  action
) {
  try {
    switch (action.type) {
      case "start":
        await sendAdminPanel(chatId);
        break;

      case "help":
        await sendHelp(chatId);
        break;

      case "addtest":
      case "create_test":
        await startCreateTest(chatId);
        break;

      case "tests":
      case "manage_tests":
        await showTests(chatId);
        break;

      case "removetest":
        await showRemoveTests(chatId);
        break;

      case "subs":
      case "subjects_menu":
        await showSubjectsMenu(chatId);
        break;

      case "cancel":
        cancelSessions(chatId);

        await safeSend(
          chatId,
          "🛑 All active operations cancelled."
        );
        break;

      case "subject_add":
        await beginAddSubject(chatId);
        break;

      case "subject_list":
        await showSubjectsList(chatId);
        break;

      case "edit_subject":
        await beginEditSubject(
          chatId,
          action.subjectId
        );
        break;

      case "remove_subject":
        await removeSubject(
          chatId,
          action.subjectId
        );
        break;

      case "test_subject":
        await toggleTestSubject(
          chatId,
          action.testId
        );
        break;

      case "test_subject_done":
        await finishSubjectSelection(chatId);
        break;

      case "view_test":
        await showTestDetails(
          chatId,
          action.testId
        );
        break;

      case "back_tests":
        await showTests(chatId);
        break;

      case "publish_test":
        await publishTest(
          chatId,
          action.testId
        );
        break;

      case "end_test":
        await endTest(
          chatId,
          action.testId
        );
        break;

      case "remove_test":
        await removeTest(
          chatId,
          action.testId
        );
        break;

      case "answer_key":
        await beginAnswerKeyUpload(
          chatId,
          action.testId
        );
        break;

      case "results":
        await safeSend(
          chatId,
          "🏆 Results module will be connected after the answer-key/scoring phase."
        );
        break;

      // ========================================================
      // ADMIN MANAGEMENT
      // ========================================================

      case "admins":
        await showAdmins(chatId);
        break;

      case "add_admin":
        if (telegramUserId !== OWNER_ID) {
          await safeSend(
            chatId,
            "❌ Only the owner can add admins."
          );
          break;
        }

        adminSessions.set(chatId, {
          step: "add_admin_id",
        });

        await safeSend(
          chatId,
          "👤 *Add Admin*\n\nSend the Telegram numeric user ID of the new admin.",
          {
            parse_mode: "Markdown",
          }
        );
        break;

      case "remove_admin":
        await showRemoveAdmins(chatId);
        break;

      case "remove_admin_selected":
        if (telegramUserId !== OWNER_ID) {
          await safeSend(
            chatId,
            "❌ Only the owner can remove admins."
          );
          break;
        }

        await removeAdmin(
          chatId,
          action.adminId
        );
        break;

      // ========================================================
      // QUESTION BUILDER
      // ========================================================

      case "add_questions":
        await showQuestionMenu(
          chatId,
          action.testId
        );
        break;

      case "question_add":
        await showQuestionTypeMenu(
          chatId,
          action.testId
        );
        break;

      case "question_type":
        if (
          ["mcq", "multiple_correct", "numerical"].includes(
            action.questionType
          )
        ) {
          if (action.id.length === 36) {
            // This can be either a test ID or question ID.
            // We determine it by checking whether the question exists.
            const { data: question } = await supabase
              .from("questions")
              .select("id")
              .eq("id", action.id)
              .maybeSingle();

            if (question) {
              await beginEditQuestionType(
                chatId,
                action.id,
                action.questionType
              );
            } else {
              await beginAddQuestion(
                chatId,
                action.id,
                action.questionType
              );
            }
          } else {
            await safeSend(
              chatId,
              "❌ Invalid question selection."
            );
          }
        }
        break;

      case "question_view":
        await showQuestions(
          chatId,
          action.testId,
          action.page
        );
        break;

      case "question_edit_list":
        await showQuestionEditList(
          chatId,
          action.testId,
          action.page
        );
        break;

      case "question_delete_list":
        await showQuestionDeleteList(
          chatId,
          action.testId,
          action.page
        );
        break;

      case "question_edit":
        await beginEditQuestion(
          chatId,
          action.questionId
        );
        break;

      case "question_edit_start":
        await beginEditQuestion(
          chatId,
          action.questionId
        );
        break;

      case "question_delete":
        await showQuestionDeleteConfirmation(
          chatId,
          action.questionId
        );
        break;

      case "question_delete_confirm":
        await deleteQuestion(
          chatId,
          action.questionId
        );
        break;

      case "question_back_menu":
        await showQuestionMenu(
          chatId,
          action.testId
        );
        break;

      case "question_back_test":
        await showTestDetails(
          chatId,
          action.testId
        );
        break;

      case "question_back_editlist":
        await showQuestionEditList(
          chatId,
          action.testId,
          0
        );
        break;

      case "question_back_deletelist":
        await showQuestionDeleteList(
          chatId,
          action.testId,
          0
        );
        break;

      default:
        await safeSend(
          chatId,
          "❌ Unknown action."
        );
    }
  } catch (error) {
    console.error(
      "Authenticated action error:",
      error
    );

    await safeSend(
      chatId,
      "❌ Something went wrong. Please try again."
    );
  }
}

// ============================================================
// PASSWORD MESSAGE HANDLER
// ============================================================

async function handlePasswordMessage(msg) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;

  const authSession = authSessions.get(chatId);

  if (!authSession) return false;

  if (
    authSession.telegramUserId !== telegramUserId
  ) {
    return false;
  }

  const password = msg.text?.trim();

  if (!password) return true;

  authSessions.delete(chatId);

  await tryDeleteMessage(
    chatId,
    msg.message_id
  );

  const admin = await getAdmin(
    telegramUserId
  );

  if (!admin) {
    await safeSend(
      chatId,
      "❌ You are no longer authorized."
    );
    return true;
  }

  const valid = verifyPassword(
    password,
    admin.password_hash
  );

  if (!valid) {
    await safeSend(
      chatId,
      "❌ Incorrect password."
    );
    return true;
  }

  await safeSend(
    chatId,
    "✅ Authentication successful."
  );

  await executeAuthenticatedAction(
    chatId,
    telegramUserId,
    authSession.action
  );

  return true;
}

// ============================================================
// TEST CREATION
// ============================================================

async function startCreateTest(chatId) {
  addTestSessions.set(chatId, {
    step: "title",
    data: {
      subjectIds: [],
    },
  });

  await safeSend(
    chatId,
    "➕ *Create New Test*\n\nEnter the test title:",
    {
      parse_mode: "Markdown",
    }
  );
}

async function handleTestCreationInput(
  msg,
  session
) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  if (session.step === "title") {
    session.data.title = text;
    session.step = "description";

    await safeSend(
      chatId,
      "📝 Enter test description:"
    );

    return;
  }

  if (session.step === "description") {
    session.data.description = text;
    session.step = "subjects";

    await showSubjectSelection(chatId);

    return;
  }

  if (session.step === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      await safeSend(
        chatId,
        "❌ Invalid date.\n\nUse format: YYYY-MM-DD"
      );
      return;
    }

    const selectedDate = new Date(
      `${text}T00:00:00+05:30`
    );

    if (Number.isNaN(selectedDate.getTime())) {
      await safeSend(
        chatId,
        "❌ Invalid date."
      );
      return;
    }

    session.data.test_date = text;
    session.step = "time";

    await safeSend(
      chatId,
      "⏰ Enter test time in 24-hour format.\n\nExample: 18:30"
    );

    return;
  }

  if (session.step === "time") {
    let normalized = text;

    if (/^\d{1,2}:\d{2}$/.test(text)) {
      const [h, m] = text.split(":");

      normalized =
        `${String(h).padStart(2, "0")}:${m}`;
    }

    if (!/^\d{2}:\d{2}$/.test(normalized)) {
      await safeSend(
        chatId,
        "❌ Invalid time.\n\nUse format HH:MM"
      );
      return;
    }

    const [hour, minute] =
      normalized.split(":").map(Number);

    if (
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59
    ) {
      await safeSend(
        chatId,
        "❌ Invalid time."
      );
      return;
    }

    const testDateTime = new Date(
      `${session.data.test_date}T${normalized}:00+05:30`
    );

    if (
      Number.isNaN(testDateTime.getTime()) ||
      testDateTime.getTime() <= Date.now()
    ) {
      await safeSend(
        chatId,
        "❌ Test date/time must be in the future."
      );
      return;
    }

    session.data.test_time = normalized;
    session.step = "duration";

    await safeSend(
      chatId,
      "⏱️ Enter test duration in minutes:"
    );

    return;
  }

  if (session.step === "duration") {
    const duration = Number(text);

    if (
      !Number.isInteger(duration) ||
      duration <= 0
    ) {
      await safeSend(
        chatId,
        "❌ Duration must be a positive integer."
      );
      return;
    }

    session.data.duration_minutes = duration;
    session.step = "questions";

    await safeSend(
      chatId,
      "🔢 Enter total number of questions:"
    );

    return;
  }

  if (session.step === "questions") {
    const totalQuestions = Number(text);

    if (
      !Number.isInteger(totalQuestions) ||
      totalQuestions < 0
    ) {
      await safeSend(
        chatId,
        "❌ Number of questions must be 0 or more."
      );
      return;
    }

    session.data.total_questions =
      totalQuestions;

    session.step = "total_marks";

    await safeSend(
      chatId,
      "🎯 Enter total marks:"
    );

    return;
  }

  if (session.step === "total_marks") {
    const totalMarks = Number(text);

    if (
      !Number.isFinite(totalMarks) ||
      totalMarks < 0
    ) {
      await safeSend(
        chatId,
        "❌ Total marks must be 0 or more."
      );
      return;
    }

    session.data.total_marks = totalMarks;

    addTestSessions.delete(chatId);

    await saveTest(chatId, session.data);
  }
}

async function saveTest(chatId, data) {
  const testCode = await generateTestCode();

  const marksPerQuestion =
    data.total_questions > 0
      ? Number(
          (
            data.total_marks /
            data.total_questions
          ).toFixed(2)
        )
      : 4;

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
          marksPerQuestion,
        negative_marking_enabled: true,
        negative_marking_value: 1,
      })
      .select()
      .single();

  if (error) {
    console.error("saveTest error:", error);

    await safeSend(
      chatId,
      `❌ Failed to create test.\n\n${error.message}`
    );

    return;
  }

  if (
    data.subjectIds &&
    data.subjectIds.length > 0
  ) {
    const rows = data.subjectIds.map(
      (subjectId) => ({
        test_id: test.id,
        subject_id: subjectId,
      })
    );

    const { error: subjectError } =
      await supabase
        .from("test_subjects")
        .insert(rows);

    if (subjectError) {
      console.error(
        "test_subjects insert error:",
        subjectError
      );

      await supabase
        .from("tests")
        .delete()
        .eq("id", test.id);

      await safeSend(
        chatId,
        "❌ Failed to save test subjects. Test creation was cancelled."
      );

      return;
    }
  }

  await safeSend(
    chatId,
    `✅ *Test Created Successfully*

📌 Title: ${test.title}
🆔 Code: \`${test.test_code}\`
📅 Date: ${test.test_date}
⏰ Time: ${test.test_time}
⏱️ Duration: ${test.duration_minutes} min
🔢 Questions: ${test.total_questions}
🎯 Total Marks: ${test.total_marks}

Status: 📝 Draft`,
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
          [
            {
              text: "📋 Manage Tests",
              callback_data: "manage_tests",
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// TEST CODE
// ============================================================

async function generateTestCode() {
  for (let i = 0; i < 20; i++) {
    const code =
      "PA-" +
      crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase();

    const { data } = await supabase
      .from("tests")
      .select("id")
      .eq("test_code", code)
      .maybeSingle();

    if (!data) {
      return code;
    }
  }

  throw new Error(
    "Unable to generate unique test code."
  );
}

// ============================================================
// SUBJECT MANAGEMENT
// ============================================================

async function showSubjectsMenu(chatId) {
  await safeSend(
    chatId,
    "📚 *Subject Management*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ Add Subject",
              callback_data: "subject_add",
            },
            {
              text: "📋 List Subjects",
              callback_data: "subject_list",
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: "start",
            },
          ],
        ],
      },
    }
  );
}

async function showSubjectsList(chatId) {
  const { data, error } =
    await supabase
      .from("subjects")
      .select("*")
      .order("name", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load subjects."
    );
    return;
  }

  if (!data.length) {
    await safeSend(
      chatId,
      "📚 No subjects found."
    );
    return;
  }

  const buttons = [];

  for (const subject of data) {
    buttons.push([
      {
        text:
          `${subject.is_active ? "🟢" : "🔴"} ${subject.name}`,
        callback_data:
          `edit_subject_${subject.id}`,
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "subjects_menu",
    },
  ]);

  await safeSend(
    chatId,
    "📚 *Subjects*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function beginAddSubject(chatId) {
  subjectSessions.set(chatId, {
    step: "add",
  });

  await safeSend(
    chatId,
    "➕ Enter the new subject name:"
  );
}

async function handleSubjectInput(
  msg,
  session
) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  if (
    session.step === "add" ||
    session.step === "edit"
  ) {
    if (text.length < 2) {
      await safeSend(
        chatId,
        "❌ Subject name is too short."
      );
      return;
    }

    if (session.step === "add") {
      const { data: existing } =
        await supabase
          .from("subjects")
          .select("id")
          .ilike("name", text)
          .maybeSingle();

      if (existing) {
        await safeSend(
          chatId,
          "❌ That subject already exists."
        );
        return;
      }

      const { error } =
        await supabase
          .from("subjects")
          .insert({
            name: text,
            is_active: true,
          });

      if (error) {
        await safeSend(
          chatId,
          `❌ Failed to add subject.\n\n${error.message}`
        );
        return;
      }

      subjectSessions.delete(chatId);

      await safeSend(
        chatId,
        `✅ Subject "${text}" added successfully.`
      );

      await showSubjectsMenu(chatId);
      return;
    }

    const { error } =
      await supabase
        .from("subjects")
        .update({
          name: text,
        })
        .eq(
          "id",
          session.subjectId
        );

    if (error) {
      await safeSend(
        chatId,
        `❌ Failed to edit subject.\n\n${error.message}`
      );
      return;
    }

    subjectSessions.delete(chatId);

    await safeSend(
      chatId,
      `✅ Subject renamed to "${text}".`
    );

    await showSubjectsList(chatId);
  }
}

async function beginEditSubject(
  chatId,
  subjectId
) {
  const { data: subject, error } =
    await supabase
      .from("subjects")
      .select("*")
      .eq("id", subjectId)
      .maybeSingle();

  if (error || !subject) {
    await safeSend(
      chatId,
      "❌ Subject not found."
    );
    return;
  }

  await safeSend(
    chatId,
    `📚 *${subject.name}*

Choose an action:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✏️ Rename",
              callback_data:
                `edit_subject_rename_${subject.id}`,
            },
          ],
          [
            {
              text: subject.is_active
                ? "🔴 Remove"
                : "🟢 Restore",
              callback_data:
                `remove_subject_${subject.id}`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data: "subject_list",
            },
          ],
        ],
      },
    }
  );

  // Handle rename callback through temporary map.
  subjectSessions.set(chatId, {
    step: "waiting_action",
    subjectId: subject.id,
  });
}

async function removeSubject(
  chatId,
  subjectId
) {
  const { data: subject } =
    await supabase
      .from("subjects")
      .select("id,name,is_active")
      .eq("id", subjectId)
      .maybeSingle();

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
        is_active: !subject.is_active,
      })
      .eq("id", subjectId);

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to update subject.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    subject.is_active
      ? `🔴 "${subject.name}" removed.`
      : `🟢 "${subject.name}" restored.`
  );

  await showSubjectsList(chatId);
}

// ============================================================
// TEST SUBJECT SELECTION
// ============================================================

async function showSubjectSelection(chatId) {
  const session =
    addTestSessions.get(chatId);

  if (!session) return;

  const { data: subjects, error } =
    await supabase
      .from("subjects")
      .select("*")
      .eq("is_active", true)
      .order("name", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load subjects."
    );
    return;
  }

  const buttons = subjects.map(
    (subject) => [
      {
        text:
          `${session.data.subjectIds.includes(subject.id) ? "☑️" : "⬜"} ${subject.name}`,
        callback_data:
          `test_subject_${subject.id}`,
      },
    ]
  );

  buttons.push([
    {
      text: "✅ Done",
      callback_data: "test_subject_done",
    },
  ]);

  await safeSend(
    chatId,
    "📚 *Select Subjects*\n\nSelect all subjects included in this test.",
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

  if (!session) {
    await safeSend(
      chatId,
      "❌ Test creation session expired."
    );
    return;
  }

  const index =
    session.data.subjectIds.indexOf(
      subjectId
    );

  if (index === -1) {
    session.data.subjectIds.push(
      subjectId
    );
  } else {
    session.data.subjectIds.splice(
      index,
      1
    );
  }

  await showSubjectSelection(chatId);
}

async function finishSubjectSelection(chatId) {
  const session =
    addTestSessions.get(chatId);

  if (!session) {
    await safeSend(
      chatId,
      "❌ Test creation session expired."
    );
    return;
  }

  if (
    session.data.subjectIds.length === 0
  ) {
    await safeSend(
      chatId,
      "❌ Select at least one subject."
    );
    return;
  }

  session.step = "date";

  await safeSend(
    chatId,
    "📅 Enter test date.\n\nFormat: YYYY-MM-DD"
  );
}

// ============================================================
// TEST LIST
// ============================================================

async function showTests(chatId) {
  const { data: tests, error } =
    await supabase
      .from("tests")
      .select("*")
      .order("created_at", {
        ascending: false,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load tests."
    );
    return;
  }

  if (!tests.length) {
    await safeSend(
      chatId,
      "📋 No tests found."
    );
    return;
  }

  const buttons = tests.map(
    (test) => [
      {
        text:
          `${statusEmoji(test.status)} ${test.title}`,
        callback_data:
          `view_test_${test.id}`,
      },
    ]
  );

  buttons.push([
    {
      text: "➕ Create Test",
      callback_data: "create_test",
    },
  ]);

  await safeSend(
    chatId,
    "📋 *All Tests*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

function statusEmoji(status) {
  if (status === "draft") return "📝";
  if (status === "published") return "🟢";
  if (status === "ended") return "🔴";

  return "⚪";
}

// ============================================================
// TEST DETAILS
// ============================================================

async function getTestSubjects(testId) {
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

  if (error) {
    console.error(
      "getTestSubjects error:",
      error
    );
    return [];
  }

  return data
    .map((row) => row.subjects?.name)
    .filter(Boolean);
}

async function showTestDetails(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const subjects =
    await getTestSubjects(testId);

  const { count: actualQuestionCount } =
    await supabase
      .from("questions")
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("test_id", testId);

  let text =
    `📋 *${test.title}*\n\n` +
    `🆔 Code: \`${test.test_code}\`\n` +
    `📚 Subjects: ${subjects.length ? subjects.join(", ") : "None"}\n` +
    `📅 Date: ${test.test_date}\n` +
    `⏰ Time: ${test.test_time}\n` +
    `⏱️ Duration: ${test.duration_minutes} min\n` +
    `🔢 Questions: ${actualQuestionCount || 0}\n` +
    `🎯 Total Marks: ${test.total_marks}\n` +
    `📌 Status: ${statusEmoji(test.status)} ${test.status}`;

  const buttons = [];

  if (test.status === "draft") {
    buttons.push([
      {
        text: "📝 Question Builder",
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

  if (test.status === "published") {
    buttons.push([
      {
        text: "🛑 End Test",
        callback_data:
          `end_test_${test.id}`,
      },
    ]);
  }

  if (test.status === "ended") {
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
      text: "🗑️ Delete Test",
      callback_data:
        `remove_test_${test.id}`,
    },
  ]);

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "manage_tests",
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// PUBLISH / END / DELETE TEST
// ============================================================

async function publishTest(
  chatId,
  testId
) {
  const { data: test } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

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

  const { count } =
    await supabase
      .from("questions")
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("test_id", testId);

  if (!count || count <= 0) {
    await safeSend(
      chatId,
      "❌ Add at least one question before publishing."
    );
    return;
  }

  const { error } =
    await supabase
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
      `❌ Failed to publish test.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    "🚀 Test published successfully!"
  );

  await showTestDetails(
    chatId,
    testId
  );
}

async function endTest(
  chatId,
  testId
) {
  const { data: test } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

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

  const { error } =
    await supabase
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
    "🛑 Test ended successfully."
  );

  await showTestDetails(
    chatId,
    testId
  );
}

async function showRemoveTests(chatId) {
  const { data: tests, error } =
    await supabase
      .from("tests")
      .select("id,title,status")
      .order("created_at", {
        ascending: false,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load tests."
    );
    return;
  }

  if (!tests.length) {
    await safeSend(
      chatId,
      "📋 No tests found."
    );
    return;
  }

  const buttons = tests.map(
    (test) => [
      {
        text:
          `🗑️ ${test.title}`,
        callback_data:
          `remove_test_${test.id}`,
      },
    ]
  );

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "manage_tests",
    },
  ]);

  await safeSend(
    chatId,
    "🗑️ *Delete Test*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function removeTest(
  chatId,
  testId
) {
  const { data: test } =
    await supabase
      .from("tests")
      .select("title")
      .eq("id", testId)
      .maybeSingle();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { error } =
    await supabase
      .from("tests")
      .delete()
      .eq("id", testId);

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to delete test.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    `🗑️ Test "${test.title}" deleted successfully.`
  );

  await showTests(chatId);
}

// ============================================================
// ANSWER KEY PLACEHOLDER
// ============================================================

async function beginAnswerKeyUpload(
  chatId,
  testId
) {
  const { data: test } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  if (test.status !== "ended") {
    await safeSend(
      chatId,
      "❌ Answer key can only be added after the test ends."
    );
    return;
  }

  await safeSend(
    chatId,
    `🔑 *Answer Key Upload*

Test: ${test.title}

The answer-key/scoring module will be connected in the next phase.

Important:
Correct answers are NOT stored during question creation.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "⬅️ Back",
              callback_data:
                `view_test_${testId}`,
            },
          ],
        ],
      },
    }
  );
}

// ============================================================
// ADMIN MANAGEMENT
// ============================================================

async function showAdmins(chatId) {
  const { data: admins, error } =
    await supabase
      .from("telegram_admins")
      .select(
        "telegram_user_id,role,is_active,created_at"
      )
      .order("role", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load admins."
    );
    return;
  }

  let text = "👥 *Admins*\n\n";

  for (const admin of admins) {
    text +=
      `${admin.role === "owner" ? "👑" : "👤"} ` +
      `${admin.telegram_user_id}` +
      ` — ${admin.role}` +
      `${admin.is_active ? "" : " (inactive)"}\n`;
  }

  const buttons = [];

  if (
    admins.some(
      (a) => a.telegram_user_id === OWNER_ID
    )
  ) {
    buttons.push([
      {
        text: "➕ Add Admin",
        callback_data: "add_admin",
      },
    ]);

    buttons.push([
      {
        text: "🗑️ Remove Admin",
        callback_data: "remove_admin",
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "start",
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function handleAdminInput(
  msg,
  session
) {
  const chatId = msg.chat.id;
  const telegramUserId = msg.from.id;
  const text = msg.text?.trim();

  if (telegramUserId !== OWNER_ID) {
    adminSessions.delete(chatId);

    await safeSend(
      chatId,
      "❌ Only the owner can manage admins."
    );

    return;
  }

  if (session.step === "add_admin_id") {
    const newAdminId = Number(text);

    if (
      !Number.isInteger(newAdminId) ||
      newAdminId <= 0
    ) {
      await safeSend(
        chatId,
        "❌ Invalid Telegram numeric ID."
      );
      return;
    }

    if (newAdminId === OWNER_ID) {
      await safeSend(
        chatId,
        "❌ Owner is already the owner."
      );
      return;
    }

    const { data: existing } =
      await supabase
        .from("telegram_admins")
        .select("*")
        .eq(
          "telegram_user_id",
          newAdminId
        )
        .maybeSingle();

    if (existing) {
      await safeSend(
        chatId,
        "❌ This Telegram ID is already registered."
      );
      return;
    }

    session.step = "add_admin_password";
    session.adminId = newAdminId;

    await safeSend(
      chatId,
      "🔐 Enter a password for this admin.\n\nMinimum 6 characters:"
    );

    return;
  }

  if (
    session.step === "add_admin_password"
  ) {
    if (text.length < 6) {
      await safeSend(
        chatId,
        "❌ Password must contain at least 6 characters."
      );
      return;
    }

    const passwordHash =
      hashPassword(text);

    const { error } =
      await supabase
        .from("telegram_admins")
        .insert({
          telegram_user_id:
            session.adminId,
          role: "admin",
          password_hash:
            passwordHash,
          is_active: true,
        });

    if (error) {
      await safeSend(
        chatId,
        `❌ Failed to add admin.\n\n${error.message}`
      );
      return;
    }

    adminSessions.delete(chatId);

    await tryDeleteMessage(
      chatId,
      msg.message_id
    );

    await safeSend(
      chatId,
      `✅ Admin ${session.adminId} added successfully.`
    );

    await showAdmins(chatId);
  }
}

async function showRemoveAdmins(chatId) {
  const { data: admins, error } =
    await supabase
      .from("telegram_admins")
      .select(
        "telegram_user_id,role,is_active"
      )
      .eq("role", "admin")
      .eq("is_active", true);

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load admins."
    );
    return;
  }

  if (!admins.length) {
    await safeSend(
      chatId,
      "👥 No removable admins found."
    );
    return;
  }

  const buttons = admins.map(
    (admin) => [
      {
        text:
          `🗑️ ${admin.telegram_user_id}`,
        callback_data:
          `remove_admin_${admin.telegram_user_id}`,
      },
    ]
  );

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data: "admins",
    },
  ]);

  await safeSend(
    chatId,
    "🗑️ *Remove Admin*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function removeAdmin(
  chatId,
  adminId
) {
  if (adminId === OWNER_ID) {
    await safeSend(
      chatId,
      "❌ Owner cannot be removed."
    );
    return;
  }

  const { data: admin } =
    await supabase
      .from("telegram_admins")
      .select("*")
      .eq(
        "telegram_user_id",
        adminId
      )
      .maybeSingle();

  if (!admin) {
    await safeSend(
      chatId,
      "❌ Admin not found."
    );
    return;
  }

  const { error } =
    await supabase
      .from("telegram_admins")
      .update({
        is_active: false,
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "telegram_user_id",
        adminId
      );

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to remove admin.\n\n${error.message}`
    );
    return;
  }

  await safeSend(
    chatId,
    `🗑️ Admin ${adminId} removed successfully.`
  );

  await showAdmins(chatId);
}

// ============================================================
// QUESTION BUILDER
// ============================================================

const QUESTION_VIEW_PAGE_SIZE = 3;
const QUESTION_LIST_PAGE_SIZE = 8;

function questionTypeLabel(type) {
  if (type === "mcq") return "MCQ";
  if (type === "multiple_correct") {
    return "Multiple Correct";
  }
  if (type === "numerical") return "Numerical";

  return type;
}

function truncateText(text, maxLength = 55) {
  if (!text) return "";

  if (text.length <= maxLength) {
    return text;
  }

  return (
    text.slice(0, maxLength - 3) +
    "..."
  );
}

async function getDraftTest(testId) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

  if (error || !test) {
    return null;
  }

  if (test.status !== "draft") {
    return null;
  }

  return test;
}

async function updateQuestionCount(
  testId
) {
  const { count, error } =
    await supabase
      .from("questions")
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("test_id", testId);

  if (error) {
    throw error;
  }

  const { error: updateError } =
    await supabase
      .from("tests")
      .update({
        total_questions: count || 0,
        updated_at:
          new Date().toISOString(),
      })
      .eq("id", testId);

  if (updateError) {
    throw updateError;
  }

  return count || 0;
}

// ============================================================
// QUESTION MENU
// ============================================================

async function showQuestionMenu(
  chatId,
  testId
) {
  const { data: test, error } =
    await supabase
      .from("tests")
      .select("*")
      .eq("id", testId)
      .maybeSingle();

  if (error || !test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { count } =
    await supabase
      .from("questions")
      .select("id", {
        count: "exact",
        head: true,
      })
      .eq("test_id", testId);

  const isDraft =
    test.status === "draft";

  let text =
    `📝 *Question Builder*\n\n` +
    `Test: ${test.title}\n` +
    `Questions: ${count || 0}\n` +
    `Status: ${statusEmoji(test.status)} ${test.status}`;

  if (!isDraft) {
    text +=
      `\n\n🔒 Question editing is locked because this test is no longer a draft.`;
  }

  const buttons = [];

  if (isDraft) {
    buttons.push([
      {
        text: "➕ Add Question",
        callback_data:
          `question_add_${testId}`,
      },
    ]);
  }

  buttons.push([
    {
      text: "👀 View Questions",
      callback_data:
        `question_view_${testId}_0`,
    },
  ]);

  if (isDraft) {
    buttons.push([
      {
        text: "✏️ Edit Question",
        callback_data:
          `question_edit_list_${testId}_0`,
      },
      {
        text: "🗑️ Delete Question",
        callback_data:
          `question_delete_list_${testId}_0`,
      },
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Back to Test",
      callback_data:
        `question_back_test_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// QUESTION TYPE MENU
// ============================================================

async function showQuestionTypeMenu(
  chatId,
  testId
) {
  const test =
    await getDraftTest(testId);

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Questions can only be added while the test is in draft status."
    );
    return;
  }

  await safeSend(
    chatId,
    "📝 *Select Question Type*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 MCQ",
              callback_data:
                `question_type_mcq_${testId}`,
            },
          ],
          [
            {
              text: "☑️ Multiple Correct",
              callback_data:
                `question_type_multiple_correct_${testId}`,
            },
          ],
          [
            {
              text: "🔢 Numerical",
              callback_data:
                `question_type_numerical_${testId}`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data:
                `question_back_menu_${testId}`,
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

async function getNextQuestionNumber(
  testId
) {
  const { data: questions, error } =
    await supabase
      .from("questions")
      .select("question_number")
      .eq("test_id", testId)
      .order("question_number", {
        ascending: false,
      })
      .limit(1);

  if (error) {
    throw error;
  }

  if (!questions.length) {
    return 1;
  }

  return (
    Number(
      questions[0].question_number
    ) + 1
  );
}

async function beginAddQuestion(
  chatId,
  testId,
  questionType
) {
  const test =
    await getDraftTest(testId);

  if (!test) {
    await safeSend(
      chatId,
      "🔒 This test is no longer editable."
    );
    return;
  }

  const questionNumber =
    await getNextQuestionNumber(
      testId
    );

  questionSessions.set(chatId, {
    mode: "add",
    testId,
    step: "question_text",
    data: {
      question_number:
        questionNumber,
      question_type:
        questionType,
      question_text: "",
      options: [],
      marks: null,
      negative_marks: null,
    },
  });

  await safeSend(
    chatId,
    `📝 *Question ${questionNumber}*

Type: ${questionTypeLabel(questionType)}

Enter the question text:`,
    {
      parse_mode: "Markdown",
    }
  );
}

// ============================================================
// QUESTION INPUT HANDLER
// ============================================================

async function handleQuestionInput(
  msg,
  session
) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  const test =
    await getDraftTest(
      session.testId
    );

  if (!test) {
    questionSessions.delete(chatId);

    await safeSend(
      chatId,
      "🔒 This test is no longer editable. Question operation cancelled."
    );

    return;
  }

  const type =
    session.data.question_type;

  // ----------------------------------------------------------
  // QUESTION TEXT
  // ----------------------------------------------------------

  if (session.step === "question_text") {
    if (!text) {
      await safeSend(
        chatId,
        "❌ Question text cannot be empty."
      );
      return;
    }

    session.data.question_text =
      text;

    if (
      type === "mcq" ||
      type === "multiple_correct"
    ) {
      session.step = "option_0";

      await safeSend(
        chatId,
        "🅰️ Enter Option A:"
      );
    } else {
      session.step = "marks";

      await safeSend(
        chatId,
        "🎯 Enter marks for this question:"
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (
    session.step.startsWith("option_")
  ) {
    const index = Number(
      session.step.split("_")[1]
    );

    if (!text) {
      await safeSend(
        chatId,
        "❌ Option cannot be empty."
      );
      return;
    }

    session.data.options[index] =
      text;

    if (index < 3) {
      const nextIndex = index + 1;

      session.step =
        `option_${nextIndex}`;

      const labels = [
        "A",
        "B",
        "C",
        "D",
      ];

      await safeSend(
        chatId,
        `🔤 Enter Option ${labels[nextIndex]}:`
      );
    } else {
      session.step = "marks";

      await safeSend(
        chatId,
        "🎯 Enter marks for this question:"
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // MARKS
  // ----------------------------------------------------------

  if (session.step === "marks") {
    const marks = Number(text);

    if (
      !Number.isFinite(marks) ||
      marks <= 0
    ) {
      await safeSend(
        chatId,
        "❌ Marks must be a number greater than 0."
      );
      return;
    }

    session.data.marks = marks;
    session.step = "negative_marks";

    await safeSend(
      chatId,
      "➖ Enter negative marks.\n\nExample: 1 or 0.5 or 0"
    );

    return;
  }

  // ----------------------------------------------------------
  // NEGATIVE MARKS
  // ----------------------------------------------------------

  if (
    session.step === "negative_marks"
  ) {
    const negativeMarks =
      Number(text);

    if (
      !Number.isFinite(
        negativeMarks
      ) ||
      negativeMarks < 0
    ) {
      await safeSend(
        chatId,
        "❌ Negative marks must be 0 or greater."
      );
      return;
    }

    session.data.negative_marks =
      negativeMarks;

    if (session.mode === "add") {
      await saveNewQuestion(
        chatId,
        session
      );
    } else {
      await saveEditedQuestion(
        chatId,
        session
      );
    }
  }
}

// ============================================================
// SAVE NEW QUESTION
// ============================================================

async function saveNewQuestion(
  chatId,
  session
) {
  const data = session.data;

  if (!data.question_text) {
    await safeSend(
      chatId,
      "❌ Question text is missing."
    );
    return;
  }

  if (
    data.question_type === "mcq" ||
    data.question_type ===
      "multiple_correct"
  ) {
    if (
      !Array.isArray(data.options) ||
      data.options.length !== 4 ||
      data.options.some(
        (option) =>
          !option ||
          !option.trim()
      )
    ) {
      await safeSend(
        chatId,
        "❌ All four options A-D are required."
      );
      return;
    }
  }

  const { data: question, error } =
    await supabase
      .from("questions")
      .insert({
        test_id: session.testId,
        question_number:
          data.question_number,
        question_text:
          data.question_text,
        question_type:
          data.question_type,
        marks: data.marks,
        negative_marks:
          data.negative_marks,
      })
      .select()
      .single();

  if (error) {
    console.error(
      "saveNewQuestion error:",
      error
    );

    await safeSend(
      chatId,
      `❌ Failed to save question.\n\n${error.message}`
    );
    return;
  }

  if (
    data.question_type === "mcq" ||
    data.question_type ===
      "multiple_correct"
  ) {
    const labels = [
      "A",
      "B",
      "C",
      "D",
    ];

    const optionRows =
      data.options.map(
        (optionText, index) => ({
          question_id:
            question.id,
          option_label:
            labels[index],
          option_text:
            optionText.trim(),
          option_order:
            index + 1,
        })
      );

    const { error: optionError } =
      await supabase
        .from("question_options")
        .insert(optionRows);

    if (optionError) {
      console.error(
        "option insert error:",
        optionError
      );

      await supabase
        .from("questions")
        .delete()
        .eq(
          "id",
          question.id
        );

      await safeSend(
        chatId,
        `❌ Failed to save options.\n\n${optionError.message}`
      );

      return;
    }
  }

  try {
    const total =
      await updateQuestionCount(
        session.testId
      );

    questionSessions.delete(chatId);

    await safeSend(
      chatId,
      `✅ *Question ${question.question_number} Added!*

Type: ${questionTypeLabel(question.question_type)}
Marks: ${question.marks}
Negative: ${question.negative_marks}

Correct answer has NOT been added.
It will be added later through the Answer Key phase.

Total questions: ${total}`,
      {
        parse_mode: "Markdown",
      }
    );

    await showQuestionMenu(
      chatId,
      session.testId
    );
  } catch (error) {
    console.error(
      "update question count error:",
      error
    );

    await safeSend(
      chatId,
      "⚠️ Question saved, but question count could not be updated automatically."
    );
  }
}

// ============================================================
// VIEW QUESTIONS
// ============================================================

async function showQuestions(
  chatId,
  testId,
  page = 0
) {
  const { data: test } =
    await supabase
      .from("tests")
      .select("id,title,status")
      .eq("id", testId)
      .maybeSingle();

  if (!test) {
    await safeSend(
      chatId,
      "❌ Test not found."
    );
    return;
  }

  const { data: questions, error } =
    await supabase
      .from("questions")
      .select("*")
      .eq("test_id", testId)
      .order("question_number", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load questions."
    );
    return;
  }

  if (!questions.length) {
    await safeSend(
      chatId,
      `📝 No questions added yet for "${test.title}".`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Add Question",
                callback_data:
                  `question_add_${testId}`,
              },
            ],
            [
              {
                text: "⬅️ Back",
                callback_data:
                  `question_back_menu_${testId}`,
              },
            ],
          ],
        },
      }
    );

    return;
  }

  const totalPages = Math.ceil(
    questions.length /
      QUESTION_VIEW_PAGE_SIZE
  );

  page = Math.max(
    0,
    Math.min(
      page,
      totalPages - 1
    )
  );

  const start =
    page *
    QUESTION_VIEW_PAGE_SIZE;

  const pageQuestions =
    questions.slice(
      start,
      start +
        QUESTION_VIEW_PAGE_SIZE
    );

  let text =
    `📖 *${test.title} — Questions*\n\n` +
    `Page ${page + 1}/${totalPages}\n\n`;

  const optionMap = new Map();

  if (
    pageQuestions.some(
      (q) =>
        q.question_type === "mcq" ||
        q.question_type ===
          "multiple_correct"
    )
  ) {
    const questionIds =
      pageQuestions.map(
        (q) => q.id
      );

    const { data: options } =
      await supabase
        .from("question_options")
        .select("*")
        .in(
          "question_id",
          questionIds
        )
        .order("option_order", {
          ascending: true,
        });

    for (const option of options || []) {
      if (
        !optionMap.has(
          option.question_id
        )
      ) {
        optionMap.set(
          option.question_id,
          []
        );
      }

      optionMap
        .get(option.question_id)
        .push(option);
    }
  }

  for (const question of pageQuestions) {
    text +=
      `*Q${question.question_number}* — ${questionTypeLabel(question.question_type)}\n` +
      `${question.question_text}\n` +
      `Marks: ${question.marks} | Negative: ${question.negative_marks}\n`;

    const options =
      optionMap.get(question.id) ||
      [];

    for (const option of options) {
      text +=
        `${option.option_label}. ${option.option_text}\n`;
    }

    text += "\n";
  }

  const buttons = [];

  const navigation = [];

  if (page > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data:
        `question_view_${testId}_${page - 1}`,
    });
  }

  if (page < totalPages - 1) {
    navigation.push({
      text: "Next ➡️",
      callback_data:
        `question_view_${testId}_${page + 1}`,
    });
  }

  if (navigation.length) {
    buttons.push(navigation);
  }

  buttons.push([
    {
      text: "⬅️ Question Builder",
      callback_data:
        `question_back_menu_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// EDIT QUESTION LIST
// ============================================================

async function showQuestionEditList(
  chatId,
  testId,
  page = 0
) {
  const test =
    await getDraftTest(testId);

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Only draft tests can be edited."
    );
    return;
  }

  const { data: questions, error } =
    await supabase
      .from("questions")
      .select(
        "id,question_number,question_text,question_type"
      )
      .eq("test_id", testId)
      .order("question_number", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load questions."
    );
    return;
  }

  if (!questions.length) {
    await safeSend(
      chatId,
      "📝 No questions available to edit.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Back",
                callback_data:
                  `question_back_menu_${testId}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  const totalPages = Math.ceil(
    questions.length /
      QUESTION_LIST_PAGE_SIZE
  );

  page = Math.max(
    0,
    Math.min(
      page,
      totalPages - 1
    )
  );

  const start =
    page *
    QUESTION_LIST_PAGE_SIZE;

  const pageQuestions =
    questions.slice(
      start,
      start +
        QUESTION_LIST_PAGE_SIZE
    );

  const buttons =
    pageQuestions.map(
      (question) => [
        {
          text:
            `✏️ Q${question.question_number} — ${truncateText(question.question_text)}`,
          callback_data:
            `question_edit_${question.id}`,
        },
      ]
    );

  const navigation = [];

  if (page > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data:
        `question_edit_list_${testId}_${page - 1}`,
    });
  }

  if (page < totalPages - 1) {
    navigation.push({
      text: "Next ➡️",
      callback_data:
        `question_edit_list_${testId}_${page + 1}`,
    });
  }

  if (navigation.length) {
    buttons.push(navigation);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data:
        `question_back_menu_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    `✏️ *Edit Question*\n\n${test.title}\nPage ${page + 1}/${totalPages}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// BEGIN EDIT QUESTION
// ============================================================

async function beginEditQuestion(
  chatId,
  questionId
) {
  const { data: question, error } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();

  if (error || !question) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const test =
    await getDraftTest(
      question.test_id
    );

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Only questions in draft tests can be edited."
    );
    return;
  }

  // Safety check: question builder does not modify answer keys.
  const { data: answerKey } =
    await supabase
      .from("answer_keys")
      .select("id")
      .eq(
        "question_id",
        questionId
      )
      .maybeSingle();

  if (answerKey) {
    await safeSend(
      chatId,
      "⚠️ This question already has an answer key. It cannot be edited from the Question Builder."
    );
    return;
  }

  await safeSend(
    chatId,
    `✏️ *Edit Q${question.question_number}*

Current type: ${questionTypeLabel(question.question_type)}

Choose the new question type:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 MCQ",
              callback_data:
                `question_type_mcq_${question.id}`,
            },
          ],
          [
            {
              text: "☑️ Multiple Correct",
              callback_data:
                `question_type_multiple_correct_${question.id}`,
            },
          ],
          [
            {
              text: "🔢 Numerical",
              callback_data:
                `question_type_numerical_${question.id}`,
            },
          ],
          [
            {
              text: "⬅️ Back",
              callback_data:
                `question_back_editlist_${question.test_id}`,
            },
          ],
        ],
      },
    }
  );
}

async function beginEditQuestionType(
  chatId,
  questionId,
  questionType
) {
  const { data: question } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();

  if (!question) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const test =
    await getDraftTest(
      question.test_id
    );

  if (!test) {
    await safeSend(
      chatId,
      "🔒 This test is no longer editable."
    );
    return;
  }

  const { data: answerKey } =
    await supabase
      .from("answer_keys")
      .select("id")
      .eq(
        "question_id",
        questionId
      )
      .maybeSingle();

  if (answerKey) {
    await safeSend(
      chatId,
      "⚠️ This question already has an answer key and cannot be edited here."
    );
    return;
  }

  questionSessions.set(chatId, {
    mode: "edit",
    testId: question.test_id,
    questionId,
    step: "question_text",
    data: {
      question_number:
        question.question_number,
      question_type:
        questionType,
      question_text: "",
      options: [],
      marks: null,
      negative_marks: null,
    },
  });

  await safeSend(
    chatId,
    `✏️ *Editing Q${question.question_number}*

New type: ${questionTypeLabel(questionType)}

Enter the new question text:`,
    {
      parse_mode: "Markdown",
    }
  );
}

// ============================================================
// SAVE EDITED QUESTION
// ============================================================

async function saveEditedQuestion(
  chatId,
  session
) {
  const data = session.data;

  const { data: existingQuestion } =
    await supabase
      .from("questions")
      .select("*")
      .eq(
        "id",
        session.questionId
      )
      .maybeSingle();

  if (!existingQuestion) {
    questionSessions.delete(chatId);

    await safeSend(
      chatId,
      "❌ Question no longer exists."
    );

    return;
  }

  if (
    !data.question_text ||
    data.question_text.trim() === ""
  ) {
    await safeSend(
      chatId,
      "❌ Question text cannot be empty."
    );
    return;
  }

  if (
    data.question_type === "mcq" ||
    data.question_type ===
      "multiple_correct"
  ) {
    if (
      !Array.isArray(data.options) ||
      data.options.length !== 4 ||
      data.options.some(
        (option) =>
          !option ||
          !option.trim()
      )
    ) {
      await safeSend(
        chatId,
        "❌ All four options A-D are required."
      );
      return;
    }
  }

  const { error: questionError } =
    await supabase
      .from("questions")
      .update({
        question_text:
          data.question_text,
        question_type:
          data.question_type,
        marks: data.marks,
        negative_marks:
          data.negative_marks,
        updated_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        session.questionId
      );

  if (questionError) {
    await safeSend(
      chatId,
      `❌ Failed to update question.\n\n${questionError.message}`
    );
    return;
  }

  const { data: oldOptions } =
    await supabase
      .from("question_options")
      .select("*")
      .eq(
        "question_id",
        session.questionId
      )
      .order("option_order", {
        ascending: true,
      });

  const needsOptions =
    data.question_type === "mcq" ||
    data.question_type ===
      "multiple_correct";

  if (!needsOptions) {
    if (oldOptions?.length) {
      const { error } =
        await supabase
          .from("question_options")
          .delete()
          .eq(
            "question_id",
            session.questionId
          );

      if (error) {
        await safeSend(
          chatId,
          `⚠️ Question updated, but old options could not be removed.\n\n${error.message}`
        );
        return;
      }
    }
  } else {
    const labels = [
      "A",
      "B",
      "C",
      "D",
    ];

    if (
      oldOptions &&
      oldOptions.length === 4
    ) {
      for (
        let i = 0;
        i < 4;
        i++
      ) {
        const { error } =
          await supabase
            .from("question_options")
            .update({
              option_label:
                labels[i],
              option_text:
                data.options[i].trim(),
              option_order:
                i + 1,
            })
            .eq(
              "id",
              oldOptions[i].id
            );

        if (error) {
          await safeSend(
            chatId,
            `❌ Failed to update option ${labels[i]}.\n\n${error.message}`
          );
          return;
        }
      }
    } else {
      if (oldOptions?.length) {
        const { error } =
          await supabase
            .from("question_options")
            .delete()
            .eq(
              "question_id",
              session.questionId
            );

        if (error) {
          await safeSend(
            chatId,
            `❌ Failed to replace old options.\n\n${error.message}`
          );
          return;
        }
      }

      const optionRows =
        data.options.map(
          (optionText, index) => ({
            question_id:
              session.questionId,
            option_label:
              labels[index],
            option_text:
              optionText.trim(),
            option_order:
              index + 1,
          })
        );

      const { error } =
        await supabase
          .from("question_options")
          .insert(optionRows);

      if (error) {
        await safeSend(
          chatId,
          `❌ Failed to save new options.\n\n${error.message}`
        );
        return;
      }
    }
  }

  questionSessions.delete(chatId);

  await safeSend(
    chatId,
    `✅ *Q${data.question_number} updated successfully.*

Type: ${questionTypeLabel(data.question_type)}
Marks: ${data.marks}
Negative: ${data.negative_marks}

Correct answer was NOT changed.`,
    {
      parse_mode: "Markdown",
    }
  );

  await showQuestionMenu(
    chatId,
    session.testId
  );
}

// ============================================================
// DELETE QUESTION LIST
// ============================================================

async function showQuestionDeleteList(
  chatId,
  testId,
  page = 0
) {
  const test =
    await getDraftTest(testId);

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Only draft tests can be modified."
    );
    return;
  }

  const { data: questions, error } =
    await supabase
      .from("questions")
      .select(
        "id,question_number,question_text,question_type"
      )
      .eq("test_id", testId)
      .order("question_number", {
        ascending: true,
      });

  if (error) {
    await safeSend(
      chatId,
      "❌ Failed to load questions."
    );
    return;
  }

  if (!questions.length) {
    await safeSend(
      chatId,
      "📝 No questions available to delete.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⬅️ Back",
                callback_data:
                  `question_back_menu_${testId}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  const totalPages = Math.ceil(
    questions.length /
      QUESTION_LIST_PAGE_SIZE
  );

  page = Math.max(
    0,
    Math.min(
      page,
      totalPages - 1
    )
  );

  const start =
    page *
    QUESTION_LIST_PAGE_SIZE;

  const pageQuestions =
    questions.slice(
      start,
      start +
        QUESTION_LIST_PAGE_SIZE
    );

  const buttons =
    pageQuestions.map(
      (question) => [
        {
          text:
            `🗑️ Q${question.question_number} — ${truncateText(question.question_text)}`,
          callback_data:
            `question_delete_${question.id}`,
        },
      ]
    );

  const navigation = [];

  if (page > 0) {
    navigation.push({
      text: "⬅️ Previous",
      callback_data:
        `question_delete_list_${testId}_${page - 1}`,
    });
  }

  if (page < totalPages - 1) {
    navigation.push({
      text: "Next ➡️",
      callback_data:
        `question_delete_list_${testId}_${page + 1}`,
    });
  }

  if (navigation.length) {
    buttons.push(navigation);
  }

  buttons.push([
    {
      text: "⬅️ Back",
      callback_data:
        `question_back_menu_${testId}`,
    },
  ]);

  await safeSend(
    chatId,
    `🗑️ *Delete Question*\n\n${test.title}\nPage ${page + 1}/${totalPages}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

// ============================================================
// DELETE CONFIRMATION
// ============================================================

async function showQuestionDeleteConfirmation(
  chatId,
  questionId
) {
  const { data: question } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();

  if (!question) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const test =
    await getDraftTest(
      question.test_id
    );

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Only questions in draft tests can be deleted."
    );
    return;
  }

  await safeSend(
    chatId,
    `⚠️ *Delete Question?*

Q${question.question_number}

${question.question_text}

This will permanently delete this question and its options.

The remaining questions will be automatically renumbered.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🗑️ Yes, Delete",
              callback_data:
                `question_delete_confirm_${question.id}`,
            },
          ],
          [
            {
              text: "❌ Cancel",
              callback_data:
                `question_back_deletelist_${question.test_id}`,
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

async function deleteQuestion(
  chatId,
  questionId
) {
  const { data: question } =
    await supabase
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .maybeSingle();

  if (!question) {
    await safeSend(
      chatId,
      "❌ Question not found."
    );
    return;
  }

  const test =
    await getDraftTest(
      question.test_id
    );

  if (!test) {
    await safeSend(
      chatId,
      "🔒 Only draft tests can be modified."
    );
    return;
  }

  const { error } =
    await supabase
      .from("questions")
      .delete()
      .eq("id", questionId);

  if (error) {
    await safeSend(
      chatId,
      `❌ Failed to delete question.\n\n${error.message}`
    );
    return;
  }

  try {
    await renumberQuestions(
      question.test_id
    );
  } catch (error) {
    console.error(
      "renumberQuestions error:",
      error
    );

    await safeSend(
      chatId,
      `⚠️ Question deleted, but automatic renumbering failed.\n\n${error.message}`
    );

    return;
  }

  await safeSend(
    chatId,
    `🗑️ Q${question.question_number} deleted successfully.

Remaining questions have been renumbered.`
  );

  await showQuestionMenu(
    chatId,
    question.test_id
  );
}

// ============================================================
// RENUMBER QUESTIONS
// ============================================================

async function renumberQuestions(
  testId
) {
  const { data: questions, error } =
    await supabase
      .from("questions")
      .select("id,question_number")
      .eq("test_id", testId)
      .order("question_number", {
        ascending: true,
      });

  if (error) {
    throw error;
  }

  const OFFSET = 1000000;

  // First move everything to temporary unique numbers.
  for (
    let i = 0;
    i < questions.length;
    i++
  ) {
    const { error: tempError } =
      await supabase
        .from("questions")
        .update({
          question_number:
            OFFSET + i,
        })
        .eq(
          "id",
          questions[i].id
        );

    if (tempError) {
      throw tempError;
    }
  }

  // Then assign clean sequential numbers.
  for (
    let i = 0;
    i < questions.length;
    i++
  ) {
    const { error: finalError } =
      await supabase
        .from("questions")
        .update({
          question_number:
            i + 1,
        })
        .eq(
          "id",
          questions[i].id
        );

    if (finalError) {
      throw finalError;
    }
  }

  await updateQuestionCount(testId);
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;

    const chatId = msg.chat.id;
    const telegramUserId = msg.from.id;

    if (msg.text.startsWith("/")) {
      return;
    }

    // Password authentication always gets priority.
    const handledPassword =
      await handlePasswordMessage(msg);

    if (handledPassword) {
      return;
    }

    const admin =
      await getAdmin(
        telegramUserId
      );

    if (!admin) {
      return;
    }

    // Question Builder session.
    const questionSession =
      questionSessions.get(chatId);

    if (questionSession) {
      await handleQuestionInput(
        msg,
        questionSession
      );
      return;
    }

    // Admin session.
    const adminSession =
      adminSessions.get(chatId);

    if (adminSession) {
      await handleAdminInput(
        msg,
        adminSession
      );
      return;
    }

    // Subject session.
    const subjectSession =
      subjectSessions.get(chatId);

    if (subjectSession) {
      if (
        subjectSession.step ===
        "waiting_action"
      ) {
        await safeSend(
          chatId,
          "Please choose an action using the buttons."
        );
        return;
      }

      await handleSubjectInput(
        msg,
        subjectSession
      );
      return;
    }

    // Test creation session.
    const testSession =
      addTestSessions.get(chatId);

    if (testSession) {
      await handleTestCreationInput(
        msg,
        testSession
      );
      return;
    }
  } catch (error) {
    console.error(
      "Message handler error:",
      error
    );
  }
});

// ============================================================
// COMMANDS
// ============================================================

bot.onText(
  /^\/start$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "start" }
    );
  }
);

bot.onText(
  /^\/help$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "help" }
    );
  }
);

bot.onText(
  /^\/addtest$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "addtest" }
    );
  }
);

bot.onText(
  /^\/tests$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "tests" }
    );
  }
);

bot.onText(
  /^\/removetest$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "removetest" }
    );
  }
);

bot.onText(
  /^\/subs$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "subs" }
    );
  }
);

bot.onText(
  /^\/admins$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "admins" }
    );
  }
);

bot.onText(
  /^\/cancel$/,
  async (msg) => {
    await requireAuth(
      msg,
      { type: "cancel" }
    );
  }
);

// ============================================================
// CALLBACK HANDLER
// ============================================================

bot.on(
  "callback_query",
  async (query) => {
    try {
      const chatId =
        query.message.chat.id;

      const telegramUserId =
        query.from.id;

      const data =
        query.data || "";

      await bot.answerCallbackQuery(
        query.id
      );

      const admin =
        await getAdmin(
          telegramUserId
        );

      if (!admin) {
        await safeSend(
          chatId,
          "❌ You are not authorized."
        );
        return;
      }

      const action =
        parseCallbackAction(data);

      if (action.type === "unknown") {
        await safeSend(
          chatId,
          "❌ Unknown button action."
        );
        return;
      }

      await requestPassword(
        chatId,
        telegramUserId,
        action
      );
    } catch (error) {
      console.error(
        "Callback handler error:",
        error
      );
    }
  }
);

// ============================================================
// SUBJECT RENAME CALLBACK FIX
// ============================================================

bot.on(
  "callback_query",
  async (query) => {
    // This listener intentionally does nothing.
    // Main callback handler above owns callback authentication.
  }
);

// ============================================================
// ERROR HANDLERS
// ============================================================

bot.on(
  "polling_error",
  (error) => {
    console.error(
      "Telegram polling error:",
      error
    );
  }
);

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

// ============================================================
// STARTUP
// ============================================================

(async () => {
  try {
    await ensureOwnerAccount();

    console.log(
      "🚀 PrepArena Admin Bot is running..."
    );
  } catch (error) {
    console.error(
      "❌ Startup failed:",
      error
    );

    process.exit(1);
  }
})();
