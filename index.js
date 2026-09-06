const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

const OWNER_TELEGRAM_ID = 8256722518;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not configured");
}

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is not configured");
}

if (!SUPABASE_SECRET_KEY) {
  throw new Error("SUPABASE_SECRET_KEY is not configured");
}

if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD is not configured");
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true
});

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
   SESSION MANAGEMENT
========================================================= */

const sessions = new Map();

const CALLBACK_PREFIX = "cb_";

function sessionKey(chatId) {
  return String(chatId);
}

function getSession(chatId) {
  const key = sessionKey(chatId);

  if (!sessions.has(key)) {
    sessions.set(key, {
      state: "idle",
      data: {},
      authenticated: false,
      authAction: null
    });
  }

  return sessions.get(key);
}

function resetSession(chatId) {
  sessions.set(sessionKey(chatId), {
    state: "idle",
    data: {},
    authenticated: false,
    authAction: null
  });
}

function clearSession(chatId) {
  sessions.delete(sessionKey(chatId));
}

/* =========================================================
   TELEGRAM HELPERS
========================================================= */

async function safeSend(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error("sendMessage error:", error.message);
    return null;
  }
}

async function answerCallback(query, text = "") {
  try {
    if (text) {
      await bot.answerCallbackQuery(query.id, {
        text
      });
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  } catch (_) {}
}

function escapeMarkdown(text) {
  return String(text ?? "").replace(
    /([_*[\]`])/g,
    "\\$1"
  );
}

function normalizeName(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isDraft(test) {
  return test && test.status === "draft";
}

function statusEmoji(status) {
  if (status === "draft") return "🟡";
  if (status === "published") return "🟢";
  return "🔴";
}

function makeCode() {
  return `PA${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/* =========================================================
   PASSWORD HASHING
========================================================= */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);

  const derivedKey = crypto.scryptSync(
    String(password),
    salt,
    64
  );

  return [
    "scrypt",
    salt.toString("hex"),
    derivedKey.toString("hex")
  ].join(":");
}

function verifyPassword(password, storedHash) {
  try {
    const parts = String(storedHash || "").split(":");

    const kind = parts[0];
    const saltHex = parts[1];
    const hashHex = parts[2];

    if (
      kind !== "scrypt" ||
      !saltHex ||
      !hashHex
    ) {
      return false;
    }

    const actual = crypto.scryptSync(
      String(password),
      Buffer.from(saltHex, "hex"),
      64
    );

    const expected = Buffer.from(
      hashHex,
      "hex"
    );

    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
  } catch (_) {
    return false;
  }
}

/* =========================================================
   OWNER ACCOUNT
========================================================= */

async function ensureOwnerAccount() {
  const {
    data,
    error
  } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id, role, is_active"
    )
    .eq(
      "telegram_user_id",
      OWNER_TELEGRAM_ID
    )
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const {
      error: insertError
    } = await supabase
      .from("telegram_admins")
      .insert({
        telegram_user_id:
          OWNER_TELEGRAM_ID,
        role: "owner",
        password_hash:
          hashPassword(OWNER_PASSWORD),
        is_active: true
      });

    if (insertError) {
      throw insertError;
    }

    console.log(
      "Owner account created."
    );

    return;
  }

  if (
    data.role !== "owner" ||
    !data.is_active
  ) {
    const {
      error: updateError
    } = await supabase
      .from("telegram_admins")
      .update({
        role: "owner",
        is_active: true,
        updated_at:
          new Date().toISOString()
      })
      .eq(
        "telegram_user_id",
        OWNER_TELEGRAM_ID
      );

    if (updateError) {
      throw updateError;
    }
  }
}

/* =========================================================
   ADMIN AUTH
========================================================= */

async function getAdmin(telegramUserId) {
  const {
    data,
    error
  } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id, role, password_hash, is_active"
    )
    .eq(
      "telegram_user_id",
      telegramUserId
    )
    .maybeSingle();

  if (error) {
    console.error(
      "getAdmin:",
      error.message
    );

    return null;
  }

  return data || null;
}

async function beginAuth(
  chatId,
  action,
  title = "🔐 Admin authentication"
) {
  const session = getSession(chatId);

  session.state = "await_password";
  session.data = {};
  session.authenticated = false;
  session.authAction = action;

  await safeSend(
    chatId,
    `${title}\n\nEnter your admin password:`
  );
}

async function showAdminGate(chatId) {
  resetSession(chatId);

  await safeSend(
    chatId,
    "🛡️ *PrepArena Admin Bot*\n\nAuthentication is required for every admin action.",
    {
      parse_mode: "Markdown"
    }
  );

  await beginAuth(
    chatId,
    "panel"
  );
}

/* =========================================================
   AUTHENTICATED ACTION ROUTER
========================================================= */

async function runAuthenticatedAction(
  chatId,
  action
) {
  if (action === "panel") {
    return sendAdminPanel(chatId);
  }

  if (action === "tests") {
    return showTests(chatId);
  }

  if (action === "create_test") {
    return startCreateTest(chatId);
  }

  if (action.startsWith("edit_test:")) {
    return showEditTestMenu(
      chatId,
      action.slice(10)
    );
  }

  if (action.startsWith("subjects:")) {
    return showTestSubjects(
      chatId,
      action.slice(9)
    );
  }

  if (action === "subs") {
    return showSubjects(chatId);
  }

  if (action === "new_subject") {
    return startNewSubject(chatId);
  }

  if (action.startsWith("edit_subject:")) {
    return startEditSubject(
      chatId,
      action.slice(13)
    );
  }

  if (action.startsWith("remove_subject:")) {
    return removeSubject(
      chatId,
      action.slice(15)
    );
  }

  if (action.startsWith("questions:")) {
    return showQuestionMenu(
      chatId,
      action.slice(10)
    );
  }

  if (action.startsWith("add_question:")) {
    return startAddQuestion(
      chatId,
      action.slice(13)
    );
  }

  if (action.startsWith("view_questions:")) {
    return viewQuestions(
      chatId,
      action.slice(15),
      0
    );
  }

  if (action.startsWith("edit_question:")) {
    return startEditQuestion(
      chatId,
      action.slice(14)
    );
  }

  if (action.startsWith("delete_question:")) {
    return confirmDeleteQuestion(
      chatId,
      action.slice(16)
    );
  }

  if (action.startsWith("publish:")) {
    return publishTest(
      chatId,
      action.slice(8)
    );
  }

  if (action.startsWith("end:")) {
    return endTest(
      chatId,
      action.slice(4)
    );
  }

  if (action.startsWith("answer_key:")) {
    return answerKeyPlaceholder(
      chatId,
      action.slice(11)
    );
  }

  if (action.startsWith("results:")) {
    return resultsPlaceholder(
      chatId,
      action.slice(8)
    );
  }

  if (action === "admins") {
    return showAdmins(chatId);
  }

  if (action === "add_admin") {
    return startAddAdmin(chatId);
  }

  if (
    action.startsWith(
      "set_admin_password:"
    )
  ) {
    return startSetAdminPassword(
      chatId,
      action.slice(19)
    );
  }

  if (
    action.startsWith(
      "disable_admin:"
    )
  ) {
    return disableAdmin(
      chatId,
      action.slice(14)
    );
  }

  return sendAdminPanel(chatId);
}

/* =========================================================
   ADMIN PANEL
========================================================= */

async function sendAdminPanel(chatId) {
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📝 Tests",
          callback_data:
            `${CALLBACK_PREFIX}tests`
        },
        {
          text: "📚 Subjects",
          callback_data:
            `${CALLBACK_PREFIX}subs`
        }
      ],
      [
        {
          text: "👥 Admins",
          callback_data:
            `${CALLBACK_PREFIX}admins`
        }
      ],
      [
        {
          text: "❓ Help",
          callback_data:
            `${CALLBACK_PREFIX}help`
        },
        {
          text: "🚪 Logout",
          callback_data:
            `${CALLBACK_PREFIX}logout`
        }
      ]
    ]
  };

  await safeSend(
    chatId,
    "🏟️ *PrepArena Admin Panel*\n\nChoose an action:",
    {
      parse_mode: "Markdown",
      reply_markup: keyboard
    }
  );
}

async function showHelp(chatId) {
  await safeSend(
    chatId,
`📖 *Admin Help*

• Tests → create/edit tests
• Subjects → add, rename or deactivate subjects
• Questions → add, view, edit or delete questions
• Numerical questions do *not* ask for a correct answer while building the test.
• Answer keys are entered after the test ends.
• Publish locks test editing.
• End marks a published test as ended.
• Owner can add/manage admins.
• Admin passwords are stored as hashes.

Use /start anytime to authenticate again.`,
    {
      parse_mode: "Markdown"
    }
  );
}

/* =========================================================
   TEST LIST
========================================================= */

async function showTests(chatId) {
  const {
    data,
    error
  } = await supabase
    .from("tests")
    .select(
      "id,title,test_code,status,test_date,test_time,duration_minutes,total_questions,total_marks"
    )
    .order("created_at", {
      ascending: false
    })
    .limit(30);

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  if (!data || !data.length) {
    return safeSend(
      chatId,
      "📝 No tests yet.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Create Test",
                callback_data:
                  `${CALLBACK_PREFIX}ct`
              }
            ],
            [
              {
                text: "⬅️ Panel",
                callback_data:
                  `${CALLBACK_PREFIX}panel`
              }
            ]
          ]
        }
      }
    );
  }

  const rows = data.map(test => [
    {
      text:
        `${statusEmoji(test.status)} ${test.title}`,
      callback_data:
        `${CALLBACK_PREFIX}et:${test.id}`
    }
  ]);

  rows.push([
    {
      text: "➕ Create Test",
      callback_data:
        `${CALLBACK_PREFIX}ct`
    }
  ]);

  rows.push([
    {
      text: "⬅️ Panel",
      callback_data:
        `${CALLBACK_PREFIX}panel`
    }
  ]);

  await safeSend(
    chatId,
    "📝 *Tests*\n\nTap a test to manage it:",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

/* =========================================================
   FETCH TEST
========================================================= */

async function fetchTest(testId) {
  const {
    data,
    error
  } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();

  if (error) {
    console.error(
      "fetchTest:",
      error.message
    );

    return null;
  }

  return data;
}

/* =========================================================
   TEST DETAIL
========================================================= */

async function showTestDetail(
  chatId,
  testId
) {
  const test = await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  const {
    data: links
  } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq("test_id", testId);

  let subjectText = "None";

  if (links && links.length) {
    const ids = links.map(
      item => item.subject_id
    );

    const {
      data: subjects
    } = await supabase
      .from("subjects")
      .select("name")
      .in("id", ids);

    subjectText =
      (subjects || [])
        .map(item => item.name)
        .join(", ") || "None";
  }

  const buttons = [
    [
      {
        text: "✏️ Edit Test",
        callback_data:
          `${CALLBACK_PREFIX}etm:${testId}`
      }
    ],
    [
      {
        text: "📚 Subjects",
        callback_data:
          `${CALLBACK_PREFIX}ts:${testId}`
      }
    ],
    [
      {
        text: "❓ Questions",
        callback_data:
          `${CALLBACK_PREFIX}qm:${testId}`
      }
    ],
    [
      {
        text: "🔑 Answer Key",
        callback_data:
          `${CALLBACK_PREFIX}ak:${testId}`
      },
      {
        text: "📊 Results",
        callback_data:
          `${CALLBACK_PREFIX}rs:${testId}`
      }
    ]
  ];

  if (test.status === "draft") {
    buttons.push([
      {
        text: "🚀 Publish",
        callback_data:
          `${CALLBACK_PREFIX}pub:${testId}`
      }
    ]);
  }

  if (test.status === "published") {
    buttons.push([
      {
        text: "⛔ End Test",
        callback_data:
          `${CALLBACK_PREFIX}end:${testId}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Tests",
      callback_data:
        `${CALLBACK_PREFIX}tests`
    }
  ]);

  await safeSend(
    chatId,
`📝 *${escapeMarkdown(test.title)}*

Code: ${test.test_code || "—"}
Status: ${test.status}
Date: ${test.test_date || "—"}
Time: ${test.test_time || "—"}
Duration: ${test.duration_minutes} min
Questions: ${test.total_questions}
Total marks: ${test.total_marks}
Marks/question: ${test.marks_per_question}
Negative marking: ${
      test.negative_marking_enabled
        ? `Yes (-${test.negative_marking_value})`
        : "No"
    }
Subjects: ${escapeMarkdown(subjectText)}

${escapeMarkdown(test.description || "")}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

/* =========================================================
   CREATE TEST
========================================================= */

async function startCreateTest(chatId) {
  const session = getSession(chatId);

  session.state = "create_title";
  session.data = {};
  session.authenticated = true;

  await safeSend(
    chatId,
    "➕ *Create Test*\n\nEnter test title:",
    {
      parse_mode: "Markdown"
    }
  );
}

async function createTestFromSession(
  chatId
) {
  const session = getSession(chatId);
  const data = session.data;

  const code =
    data.testCode || makeCode();

  const payload = {
    title: data.title,
    description:
      data.description || null,
    test_code: code,
    status: "draft",
    test_date:
      data.testDate || null,
    test_time:
      data.testTime || null,
    duration_minutes:
      data.duration || 180,
    total_questions: 0,
    total_marks: 0,
    marks_per_question:
      data.marksPerQuestion || 4,
    negative_marking_enabled:
      data.negativeEnabled,
    negative_marking_value:
      data.negativeValue || 1,
    instructions:
      data.instructions || null
  };

  const {
    data: test,
    error
  } = await supabase
    .from("tests")
    .insert(payload)
    .select()
    .single();

  if (error) {
    return safeSend(
      chatId,
      `❌ Could not create test: ${error.message}`
    );
  }

  resetSession(chatId);

  const newSession =
    getSession(chatId);

  newSession.authenticated = true;

  await safeSend(
    chatId,
    `✅ Test created!\n\nCode: ${test.test_code}`
  );

  await showTestDetail(
    chatId,
    test.id
  );
}

/* =========================================================
   EDIT TEST
========================================================= */

async function showEditTestMenu(
  chatId,
  testId
) {
  const test = await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Published/ended tests are locked."
    );
  }

  await safeSend(
    chatId,
`✏️ *Edit Test*

${escapeMarkdown(test.title)}

Choose a field:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Title",
              callback_data:
                `${CALLBACK_PREFIX}field:title:${testId}`
            }
          ],
          [
            {
              text: "Description",
              callback_data:
                `${CALLBACK_PREFIX}field:desc:${testId}`
            }
          ],
          [
            {
              text: "Date",
              callback_data:
                `${CALLBACK_PREFIX}field:date:${testId}`
            },
            {
              text: "Time",
              callback_data:
                `${CALLBACK_PREFIX}field:time:${testId}`
            }
          ],
          [
            {
              text: "Duration",
              callback_data:
                `${CALLBACK_PREFIX}field:duration:${testId}`
            }
          ],
          [
            {
              text: "Marks/Question",
              callback_data:
                `${CALLBACK_PREFIX}field:marks:${testId}`
            }
          ],
          [
            {
              text: "Negative Marking",
              callback_data:
                `${CALLBACK_PREFIX}field:negative:${testId}`
            }
          ],
          [
            {
              text: "Instructions",
              callback_data:
                `${CALLBACK_PREFIX}field:instructions:${testId}`
            }
          ],
          [
            {
              text: "⬅️ Back",
              callback_data:
                `${CALLBACK_PREFIX}et:${testId}`
            }
          ]
        ]
      }
    }
  );
}

async function saveTestField(
  chatId,
  testId,
  field,
  value
) {
  const test =
    await fetchTest(testId);

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const patch = {};

  if (field === "title") {
    if (!value.trim()) {
      return safeSend(
        chatId,
        "❌ Title cannot be empty."
      );
    }

    patch.title = value.trim();
  }

  else if (field === "desc") {
    patch.description =
      value || null;
  }

  else if (field === "date") {
    if (
      value &&
      !/^\d{4}-\d{2}-\d{2}$/.test(
        value
      )
    ) {
      return safeSend(
        chatId,
        "❌ Use YYYY-MM-DD."
      );
    }

    patch.test_date =
      value || null;
  }

  else if (field === "time") {
    if (
      value &&
      !/^\d{2}:\d{2}$/.test(
        value
      )
    ) {
      return safeSend(
        chatId,
        "❌ Use HH:MM."
      );
    }

    patch.test_time =
      value || null;
  }

  else if (field === "duration") {
    const number = Number(value);

    if (
      !Number.isInteger(number) ||
      number <= 0
    ) {
      return safeSend(
        chatId,
        "❌ Duration must be a positive integer."
      );
    }

    patch.duration_minutes =
      number;
  }

  else if (field === "marks") {
    const number = Number(value);

    if (!(number > 0)) {
      return safeSend(
        chatId,
        "❌ Marks must be positive."
      );
    }

    patch.marks_per_question =
      number;
  }

  else if (field === "negative") {
    const parts = String(value)
      .split(",")
      .map(item => item.trim());

    const enabled =
      parts[0].toLowerCase() ===
      "yes";

    const number =
      Number(parts[1] || 1);

    if (
      enabled &&
      !(number >= 0)
    ) {
      return safeSend(
        chatId,
        "❌ Invalid negative marks."
      );
    }

    patch.negative_marking_enabled =
      enabled;

    patch.negative_marking_value =
      number >= 0
        ? number
        : 1;
  }

  else if (field === "instructions") {
    patch.instructions =
      value || null;
  }

  const {
    error
  } = await supabase
    .from("tests")
    .update({
      ...patch,
      updated_at:
        new Date().toISOString()
    })
    .eq("id", testId);

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Updated."
  );

  await showEditTestMenu(
    chatId,
    testId
  );
}

/* =========================================================
   SUBJECTS
========================================================= */

async function showSubjects(chatId) {
  const {
    data,
    error
  } = await supabase
    .from("subjects")
    .select("*")
    .order("name");

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  const rows =
    (data || []).map(subject => [
      {
        text:
          `${subject.is_active ? "🟢" : "⚪"} ${subject.name}`,
        callback_data:
          `${CALLBACK_PREFIX}es:${subject.id}`
      }
    ]);

  rows.push([
    {
      text: "➕ Add Subject",
      callback_data:
        `${CALLBACK_PREFIX}ns`
    }
  ]);

  rows.push([
    {
      text: "⬅️ Panel",
      callback_data:
        `${CALLBACK_PREFIX}panel`
    }
  ]);

  await safeSend(
    chatId,
    "📚 *Subjects*\n\n🟢 Active  ⚪ Inactive",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function startNewSubject(chatId) {
  const session = getSession(chatId);

  session.state = "subject_new";
  session.data = {};
  session.authenticated = true;

  await safeSend(
    chatId,
    "➕ Enter subject name:"
  );
}

async function startEditSubject(
  chatId,
  subjectId
) {
  const {
    data
  } = await supabase
    .from("subjects")
    .select("*")
    .eq("id", subjectId)
    .maybeSingle();

  if (!data) {
    return safeSend(
      chatId,
      "❌ Subject not found."
    );
  }

  const session =
    getSession(chatId);

  session.state =
    "subject_edit";

  session.data = {
    subjectId
  };

  session.authenticated = true;

  await safeSend(
    chatId,
    `✏️ Current name: ${data.name}\n\nEnter new name:`
  );
}

async function saveNewSubject(
  chatId,
  name
) {
  name = normalizeName(name);

  if (!name) {
    return safeSend(
      chatId,
      "❌ Name cannot be empty."
    );
  }

  const {
    error
  } = await supabase
    .from("subjects")
    .insert({
      name,
      is_active: true
    });

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Subject added."
  );

  await showSubjects(chatId);
}

async function saveEditedSubject(
  chatId,
  subjectId,
  name
) {
  name = normalizeName(name);

  if (!name) {
    return safeSend(
      chatId,
      "❌ Name cannot be empty."
    );
  }

  const {
    error
  } = await supabase
    .from("subjects")
    .update({
      name,
      updated_at:
        new Date().toISOString()
    })
    .eq("id", subjectId);

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Subject renamed."
  );

  await showSubjects(chatId);
}

async function removeSubject(
  chatId,
  subjectId
) {
  const {
    data,
    error
  } = await supabase
    .from("subjects")
    .update({
      is_active: false
    })
    .eq("id", subjectId)
    .select()
    .maybeSingle();

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  if (!data) {
    return safeSend(
      chatId,
      "❌ Subject not found."
    );
  }

  await safeSend(
    chatId,
    "✅ Subject deactivated."
  );

  await showSubjects(chatId);
}

/* =========================================================
   TEST SUBJECTS
========================================================= */

async function showTestSubjects(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const {
    data: subjects
  } = await supabase
    .from("subjects")
    .select("*")
    .eq("is_active", true)
    .order("name");

  const {
    data: links
  } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq("test_id", testId);

  const selected =
    new Set(
      (links || []).map(
        item => item.subject_id
      )
    );

  const rows =
    (subjects || []).map(subject => [
      {
        text:
          `${selected.has(subject.id) ? "☑️" : "⬜"} ${subject.name}`,
        callback_data:
          `${CALLBACK_PREFIX}tog:${testId}:${subject.id}`
      }
    ]);

  rows.push([
    {
      text: "✅ Done",
      callback_data:
        `${CALLBACK_PREFIX}et:${testId}`
    }
  ]);

  await safeSend(
    chatId,
    `📚 Subjects for ${test.title}:`,
    {
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function toggleTestSubject(
  chatId,
  testId,
  subjectId
) {
  const test =
    await fetchTest(testId);

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const {
    data: existing
  } = await supabase
    .from("test_subjects")
    .select("*")
    .eq("test_id", testId)
    .eq("subject_id", subjectId)
    .maybeSingle();

  let error;

  if (existing) {
    ({
      error
    } = await supabase
      .from("test_subjects")
      .delete()
      .eq("test_id", testId)
      .eq(
        "subject_id",
        subjectId
      ));
  } else {
    ({
      error
    } = await supabase
      .from("test_subjects")
      .insert({
        test_id: testId,
        subject_id: subjectId
      }));
  }

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  await showTestSubjects(
    chatId,
    testId
  );
}

/* =========================================================
   QUESTION BUILDER MENU
========================================================= */

async function showQuestionMenu(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  const locked =
    !isDraft(test);

  const rows = [];

  if (!locked) {
    rows.push([
      {
        text: "➕ Add Question",
        callback_data:
          `${CALLBACK_PREFIX}aq:${testId}`
      }
    ]);
  }

  rows.push([
    {
      text: "📋 View Questions",
      callback_data:
        `${CALLBACK_PREFIX}vq:${testId}`
    }
  ]);

  if (!locked) {
    rows.push([
      {
        text: "✏️ Edit Question",
        callback_data:
          `${CALLBACK_PREFIX}eqpick:${testId}`
      }
    ]);

    rows.push([
      {
        text: "🗑️ Delete Question",
        callback_data:
          `${CALLBACK_PREFIX}dqpick:${testId}`
      }
    ]);
  }

  rows.push([
    {
      text: "⬅️ Back",
      callback_data:
        `${CALLBACK_PREFIX}et:${testId}`
    }
  ]);

  await safeSend(
    chatId,
`❓ *Question Builder*

Test: ${escapeMarkdown(test.title)}
Questions: ${test.total_questions}
Marks: ${test.total_marks}

${
      locked
        ? `🔒 Locked because test is ${test.status}.`
        : "Choose an action:"
    }`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

/* =========================================================
   NEXT QUESTION NUMBER
========================================================= */

async function nextQuestionNumber(
  testId
) {
  const {
    data
  } = await supabase
    .from("questions")
    .select("question_number")
    .eq("test_id", testId)
    .order("question_number", {
      ascending: false
    })
    .limit(1);

  if (
    data &&
    data.length
  ) {
    return (
      Number(data[0].question_number) +
      1
    );
  }

  return 1;
}

/* =========================================================
   ADD QUESTION
========================================================= */

async function startAddQuestion(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const session =
    getSession(chatId);

  session.state =
    "question_type";

  session.data = {
    testId,
    questionNumber:
      await nextQuestionNumber(
        testId
      )
  };

  session.authenticated = true;

  await safeSend(
    chatId,
`➕ Question #${session.data.questionNumber}

Select question type:`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "MCQ",
              callback_data:
                `${CALLBACK_PREFIX}qtype:mcq`
            }
          ],
          [
            {
              text: "Multiple Correct",
              callback_data:
                `${CALLBACK_PREFIX}qtype:multiple_correct`
            }
          ],
          [
            {
              text: "Numerical",
              callback_data:
                `${CALLBACK_PREFIX}qtype:numerical`
            }
          ],
          [
            {
              text: "❌ Cancel",
              callback_data:
                `${CALLBACK_PREFIX}cancel`
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   SAVE QUESTION
========================================================= */

async function saveQuestion(chatId) {
  const session =
    getSession(chatId);

  const data =
    session.data;

  const questionPayload = {
    test_id: data.testId,
    question_number:
      data.questionNumber,
    question_text:
      data.questionText,
    question_type:
      data.questionType,
    marks: data.marks,
    negative_marks:
      data.negativeMarks
  };

  const {
    data: question,
    error
  } = await supabase
    .from("questions")
    .insert(questionPayload)
    .select()
    .single();

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  if (
    data.questionType !==
    "numerical"
  ) {
    const options =
      data.options.map(
        (text, index) => ({
          question_id:
            question.id,
          option_label:
            String.fromCharCode(
              65 + index
            ),
          option_text:
            text,
          option_order:
            index + 1
        })
      );

    const {
      error: optionsError
    } = await supabase
      .from("question_options")
      .insert(options);

    if (optionsError) {
      await supabase
        .from("questions")
        .delete()
        .eq(
          "id",
          question.id
        );

      return safeSend(
        chatId,
        `❌ ${optionsError.message}`
      );
    }
  }

  await recalcTestTotals(
    data.testId
  );

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    `✅ Question #${data.questionNumber} saved.`
  );

  await showQuestionMenu(
    chatId,
    data.testId
  );
}

/* =========================================================
   PROCESS ADD QUESTION INPUT
========================================================= */

async function processQuestionInput(
  chatId,
  text
) {
  const session =
    getSession(chatId);

  const data =
    session.data;

  if (
    session.state ===
    "question_text"
  ) {
    data.questionText =
      text.trim();

    if (!data.questionText) {
      return safeSend(
        chatId,
        "❌ Question text cannot be empty."
      );
    }

    /*
      IMPORTANT:
      Numerical questions DO NOT ask
      for the correct answer here.
      Answer key is entered later.
    */

    if (
      data.questionType ===
      "numerical"
    ) {
      session.state =
        "question_marks";

      return safeSend(
        chatId,
        "Enter marks (positive number):"
      );
    }

    session.state =
      "option_a";

    return safeSend(
      chatId,
      "Option A:"
    );
  }

  if (
    session.state === "option_a" ||
    session.state === "option_b" ||
    session.state === "option_c" ||
    session.state === "option_d"
  ) {
    const indexMap = {
      option_a: 0,
      option_b: 1,
      option_c: 2,
      option_d: 3
    };

    const index =
      indexMap[session.state];

    data.options =
      data.options || [];

    if (!text.trim()) {
      return safeSend(
        chatId,
        "❌ Option cannot be empty."
      );
    }

    data.options[index] =
      text.trim();

    if (
      session.state ===
      "option_a"
    ) {
      session.state =
        "option_b";

      return safeSend(
        chatId,
        "Option B:"
      );
    }

    if (
      session.state ===
      "option_b"
    ) {
      session.state =
        "option_c";

      return safeSend(
        chatId,
        "Option C:"
      );
    }

    if (
      session.state ===
      "option_c"
    ) {
      session.state =
        "option_d";

      return safeSend(
        chatId,
        "Option D:"
      );
    }

    session.state =
      "question_marks";

    return safeSend(
      chatId,
      "Enter marks (positive number):"
    );
  }

  if (
    session.state ===
    "question_marks"
  ) {
    const number =
      Number(text);

    if (!(number > 0)) {
      return safeSend(
        chatId,
        "❌ Marks must be positive."
      );
    }

    data.marks =
      number;

    session.state =
      "question_negative";

    return safeSend(
      chatId,
      "Enter negative marks (0 or positive number):"
    );
  }

  if (
    session.state ===
    "question_negative"
  ) {
    const number =
      Number(text);

    if (!(number >= 0)) {
      return safeSend(
        chatId,
        "❌ Negative marks must be 0 or more."
      );
    }

    data.negativeMarks =
      number;

    return saveQuestion(
      chatId
    );
  }
}

/* =========================================================
   VIEW QUESTIONS
========================================================= */

async function viewQuestions(
  chatId,
  testId,
  page = 0
) {
  const limit = 8;

  const from =
    page * limit;

  const to =
    from + limit - 1;

  const {
    data,
    error
  } = await supabase
    .from("questions")
    .select(
      "id,question_number,question_text,question_type,marks,negative_marks"
    )
    .eq("test_id", testId)
    .order("question_number")
    .range(from, to);

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  if (
    !data.length &&
    page === 0
  ) {
    return safeSend(
      chatId,
      "📋 No questions yet."
    );
  }

  let text =
    "📋 *Questions*\n\n";

  for (const question of data) {
    text +=
      `*Q${question.question_number}* [${question.question_type}] +${question.marks}/-${question.negative_marks}\n` +
      `${escapeMarkdown(question.question_text.slice(0, 180))}\n\n`;
  }

  const buttons = [];

  if (page > 0) {
    buttons.push({
      text: "⬅️ Prev",
      callback_data:
        `${CALLBACK_PREFIX}vqp:${testId}:${page - 1}`
    });
  }

  if (
    data.length ===
    limit
  ) {
    buttons.push({
      text: "Next ➡️",
      callback_data:
        `${CALLBACK_PREFIX}vqn:${testId}:${page + 1}`
    });
  }

  buttons.push({
    text: "⬅️ Back",
    callback_data:
      `${CALLBACK_PREFIX}qm:${testId}`
  });

  await safeSend(
    chatId,
    text,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          buttons
        ]
      }
    }
  );
}

/* =========================================================
   QUESTION PICKER
========================================================= */

async function pickQuestion(
  chatId,
  testId,
  mode
) {
  const {
    data,
    error
  } = await supabase
    .from("questions")
    .select(
      "id,question_number,question_text"
    )
    .eq("test_id", testId)
    .order("question_number");

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  if (!data.length) {
    return safeSend(
      chatId,
      "No questions."
    );
  }

  const rows =
    data.map(question => [
      {
        text:
          `Q${question.question_number}: ${question.question_text.slice(0, 45)}`,
        callback_data:
          `${CALLBACK_PREFIX}${mode}:${question.id}`
      }
    ]);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data:
        `${CALLBACK_PREFIX}qm:${testId}`
    }
  ]);

  await safeSend(
    chatId,
    mode === "eqpick"
      ? "✏️ Select question to edit:"
      : "🗑️ Select question to delete:",
    {
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

/* =========================================================
   LOAD QUESTION
========================================================= */

async function loadQuestion(
  questionId
) {
  const {
    data,
    error
  } = await supabase
    .from("questions")
    .select("*")
    .eq("id", questionId)
    .maybeSingle();

  if (error) {
    return null;
  }

  return data;
}

/* =========================================================
   EDIT QUESTION
========================================================= */

async function startEditQuestion(
  chatId,
  questionId
) {
  const question =
    await loadQuestion(
      questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  const test =
    await fetchTest(
      question.test_id
    );

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const {
    data: options
  } = await supabase
    .from("question_options")
    .select("*")
    .eq(
      "question_id",
      questionId
    )
    .order("option_order");

  const session =
    getSession(chatId);

  session.state =
    "edit_question_menu";

  session.data = {
    questionId,
    testId:
      question.test_id
  };

  session.authenticated =
    true;

  await showEditQuestionMenu(
    chatId,
    question,
    options || []
  );
}

async function showEditQuestionMenu(
  chatId,
  question,
  options
) {
  let body =
`✏️ *Edit Q${question.question_number}*

${escapeMarkdown(question.question_text)}
Type: ${question.question_type}
Marks: ${question.marks}
Negative: ${question.negative_marks}`;

  if (options.length) {
    body +=
      "\n\n" +
      options
        .map(
          option =>
            `${option.option_label}. ${escapeMarkdown(option.option_text)}`
        )
        .join("\n");
  }

  const rows = [
    [
      {
        text: "Question Text",
        callback_data:
          `${CALLBACK_PREFIX}eqf:text:${question.id}`
      }
    ],
    [
      {
        text: "Question Type",
        callback_data:
          `${CALLBACK_PREFIX}eqf:type:${question.id}`
      }
    ]
  ];

  if (options.length) {
    rows.push([
      {
        text: "Options",
        callback_data:
          `${CALLBACK_PREFIX}eqf:opts:${question.id}`
      }
    ]);
  }

  rows.push([
    {
      text: "Marks",
      callback_data:
        `${CALLBACK_PREFIX}eqf:marks:${question.id}`
    },
    {
      text: "Negative",
      callback_data:
        `${CALLBACK_PREFIX}eqf:neg:${question.id}`
    }
  ]);

  rows.push([
    {
      text: "⬅️ Back",
      callback_data:
        `${CALLBACK_PREFIX}qm:${question.test_id}`
    }
  ]);

  await safeSend(
    chatId,
    body,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function editQuestionField(
  chatId,
  questionId,
  field
) {
  const question =
    await loadQuestion(
      questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  const session =
    getSession(chatId);

  session.state =
    `edit_${field}`;

  session.data = {
    questionId,
    testId:
      question.test_id
  };

  if (field === "type") {
    return safeSend(
      chatId,
      "Select new type:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "MCQ",
                callback_data:
                  `${CALLBACK_PREFIX}eqt:mcq:${questionId}`
              }
            ],
            [
              {
                text: "Multiple Correct",
                callback_data:
                  `${CALLBACK_PREFIX}eqt:multiple_correct:${questionId}`
              }
            ],
            [
              {
                text: "Numerical",
                callback_data:
                  `${CALLBACK_PREFIX}eqt:numerical:${questionId}`
              }
            ]
          ]
        }
      }
    );
  }

  if (field === "opts") {
    const {
      data: options
    } = await supabase
      .from("question_options")
      .select("*")
      .eq(
        "question_id",
        questionId
      )
      .order("option_order");

    session.data.options =
      (options || []).map(
        option =>
          option.option_text
      );

    session.state =
      "edit_option_a";

    return safeSend(
      chatId,
      "Option A:"
    );
  }

  const prompts = {
    text:
      "Enter new question text:",
    marks:
      "Enter new marks:",
    neg:
      "Enter new negative marks:"
  };

  await safeSend(
    chatId,
    prompts[field] ||
      "Enter value:"
  );
}

async function updateQuestionText(
  chatId,
  text
) {
  const session =
    getSession(chatId);

  const question =
    await loadQuestion(
      session.data.questionId
    );

  if (!text.trim()) {
    return safeSend(
      chatId,
      "❌ Cannot be empty."
    );
  }

  const {
    error
  } = await supabase
    .from("questions")
    .update({
      question_text:
        text.trim()
    })
    .eq(
      "id",
      question.id
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  return finishQuestionEdit(
    chatId,
    question.id
  );
}

async function finishQuestionEdit(
  chatId,
  questionId
) {
  const question =
    await loadQuestion(
      questionId
    );

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Question updated."
  );

  const {
    data: options
  } = await supabase
    .from("question_options")
    .select("*")
    .eq(
      "question_id",
      questionId
    )
    .order("option_order");

  await showEditQuestionMenu(
    chatId,
    question,
    options || []
  );
}

/* =========================================================
   SAVE EDITED OPTIONS
========================================================= */

async function saveEditedOptions(
  chatId
) {
  const session =
    getSession(chatId);

  const question =
    await loadQuestion(
      session.data.questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  if (
    question.question_type ===
    "numerical"
  ) {
    return safeSend(
      chatId,
      "❌ Numerical questions do not have options."
    );
  }

  const options =
    session.data.options || [];

  if (
    options.length !== 4 ||
    options.some(
      value =>
        !String(value || "").trim()
    )
  ) {
    return safeSend(
      chatId,
      "❌ All four options are required."
    );
  }

  const {
    error: deleteError
  } = await supabase
    .from("question_options")
    .delete()
    .eq(
      "question_id",
      question.id
    );

  if (deleteError) {
    return safeSend(
      chatId,
      `❌ ${deleteError.message}`
    );
  }

  const rows =
    options.map(
      (text, index) => ({
        question_id:
          question.id,
        option_label:
          String.fromCharCode(
            65 + index
          ),
        option_text:
          String(text).trim(),
        option_order:
          index + 1
      })
    );

  const {
    error: insertError
  } = await supabase
    .from("question_options")
    .insert(rows);

  if (insertError) {
    return safeSend(
      chatId,
      `❌ ${insertError.message}`
    );
  }

  return finishQuestionEdit(
    chatId,
    question.id
  );
}

/* =========================================================
   CHANGE QUESTION TYPE
========================================================= */

async function changeQuestionType(
  chatId,
  type,
  questionId
) {
  const question =
    await loadQuestion(
      questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  const test =
    await fetchTest(
      question.test_id
    );

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  if (
    question.question_type ===
    type
  ) {
    return finishQuestionEdit(
      chatId,
      questionId
    );
  }

  if (
    question.question_type !==
    "numerical"
  ) {
    const {
      error
    } = await supabase
      .from("question_options")
      .delete()
      .eq(
        "question_id",
        questionId
      );

    if (error) {
      return safeSend(
        chatId,
        `❌ ${error.message}`
      );
    }
  }

  const {
    error
  } = await supabase
    .from("questions")
    .update({
      question_type: type
    })
    .eq(
      "id",
      questionId
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  /*
    IMPORTANT:
    Numerical type does NOT ask for
    a correct numerical answer.
    Answer key is entered later.
  */

  if (type === "numerical") {
    return finishQuestionEdit(
      chatId,
      questionId
    );
  }

  const session =
    getSession(chatId);

  session.state =
    "edit_option_a";

  session.data = {
    questionId,
    testId:
      question.test_id,
    options: []
  };

  return safeSend(
    chatId,
    "Option A:"
  );
}

/* =========================================================
   PROCESS EDIT QUESTION INPUT
========================================================= */

async function processEditInput(
  chatId,
  text
) {
  const session =
    getSession(chatId);

  const data =
    session.data;

  const question =
    await loadQuestion(
      data.questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  if (
    session.state ===
    "edit_text"
  ) {
    return updateQuestionText(
      chatId,
      text
    );
  }

  if (
    session.state ===
    "edit_marks"
  ) {
    const number =
      Number(text);

    if (!(number > 0)) {
      return safeSend(
        chatId,
        "❌ Marks must be positive."
      );
    }

    const {
      error
    } = await supabase
      .from("questions")
      .update({
        marks: number
      })
      .eq(
        "id",
        question.id
      );

    if (error) {
      return safeSend(
        chatId,
        `❌ ${error.message}`
      );
    }

    return finishQuestionEdit(
      chatId,
      question.id
    );
  }

  if (
    session.state ===
    "edit_neg"
  ) {
    const number =
      Number(text);

    if (!(number >= 0)) {
      return safeSend(
        chatId,
        "❌ Negative marks must be 0 or more."
      );
    }

    const {
      error
    } = await supabase
      .from("questions")
      .update({
        negative_marks:
          number
      })
      .eq(
        "id",
        question.id
      );

    if (error) {
      return safeSend(
        chatId,
        `❌ ${error.message}`
      );
    }

    return finishQuestionEdit(
      chatId,
      question.id
    );
  }

  if (
    /^edit_option_[a-d]$/.test(
      session.state
    )
  ) {
    const indexMap = {
      edit_option_a: 0,
      edit_option_b: 1,
      edit_option_c: 2,
      edit_option_d: 3
    };

    const index =
      indexMap[session.state];

    if (!text.trim()) {
      return safeSend(
        chatId,
        "❌ Option cannot be empty."
      );
    }

    data.options =
      data.options || [];

    data.options[index] =
      text.trim();

    if (index < 3) {
      const states = [
        "edit_option_a",
        "edit_option_b",
        "edit_option_c",
        "edit_option_d"
      ];

      session.state =
        states[index + 1];

      return safeSend(
        chatId,
        `Option ${String.fromCharCode(66 + index)}:`
      );
    }

    return saveEditedOptions(
      chatId
    );
  }
}

/* =========================================================
   DELETE QUESTION
========================================================= */

async function confirmDeleteQuestion(
  chatId,
  questionId
) {
  const question =
    await loadQuestion(
      questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  const test =
    await fetchTest(
      question.test_id
    );

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  await safeSend(
    chatId,
`⚠️ Delete Q${question.question_number}?

This will also delete its options.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "❌ Yes, delete",
              callback_data:
                `${CALLBACK_PREFIX}del:${questionId}`
            }
          ],
          [
            {
              text: "Cancel",
              callback_data:
                `${CALLBACK_PREFIX}qm:${question.test_id}`
            }
          ]
        ]
      }
    }
  );
}

async function deleteQuestion(
  chatId,
  questionId
) {
  const question =
    await loadQuestion(
      questionId
    );

  if (!question) {
    return safeSend(
      chatId,
      "❌ Question not found."
    );
  }

  const test =
    await fetchTest(
      question.test_id
    );

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Test is locked."
    );
  }

  const {
    error: deleteError
  } = await supabase
    .from("questions")
    .delete()
    .eq(
      "id",
      questionId
    );

  if (deleteError) {
    return safeSend(
      chatId,
      `❌ ${deleteError.message}`
    );
  }

  const {
    data: remaining,
    error: remainingError
  } = await supabase
    .from("questions")
    .select(
      "id,question_number"
    )
    .eq(
      "test_id",
      question.test_id
    )
    .order("question_number");

  if (remainingError) {
    return safeSend(
      chatId,
      `❌ ${remainingError.message}`
    );
  }

  /*
    Temporary numbering avoids
    unique(test_id, question_number)
    conflicts during renumbering.
  */

  for (
    let index = 0;
    index < remaining.length;
    index++
  ) {
    const temporaryNumber =
      1000000 + index;

    const {
      error
    } = await supabase
      .from("questions")
      .update({
        question_number:
          temporaryNumber
      })
      .eq(
        "id",
        remaining[index].id
      );

    if (error) {
      return safeSend(
        chatId,
        `❌ ${error.message}`
      );
    }
  }

  for (
    let index = 0;
    index < remaining.length;
    index++
  ) {
    const {
      error
    } = await supabase
      .from("questions")
      .update({
        question_number:
          index + 1
      })
      .eq(
        "id",
        remaining[index].id
      );

    if (error) {
      return safeSend(
        chatId,
        `❌ ${error.message}`
      );
    }
  }

  await recalcTestTotals(
    question.test_id
  );

  await safeSend(
    chatId,
    "🗑️ Question deleted and remaining questions renumbered."
  );

  await showQuestionMenu(
    chatId,
    question.test_id
  );
}

/* =========================================================
   TEST TOTALS
========================================================= */

async function recalcTestTotals(
  testId
) {
  const {
    data,
    error
  } = await supabase
    .from("questions")
    .select("marks")
    .eq(
      "test_id",
      testId
    );

  if (error) {
    console.error(
      "recalcTestTotals:",
      error.message
    );

    return;
  }

  const totalMarks =
    (data || []).reduce(
      (sum, question) =>
        sum +
        Number(
          question.marks || 0
        ),
      0
    );

  await supabase
    .from("tests")
    .update({
      total_questions:
        (data || []).length,
      total_marks:
        totalMarks,
      updated_at:
        new Date().toISOString()
    })
    .eq(
      "id",
      testId
    );
}

/* =========================================================
   PUBLISH / END TEST
========================================================= */

async function publishTest(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  if (!isDraft(test)) {
    return safeSend(
      chatId,
      "🔒 Only draft tests can be published."
    );
  }

  if (!test.total_questions) {
    return safeSend(
      chatId,
      "❌ Add at least one question before publishing."
    );
  }

  const {
    data: subjects
  } = await supabase
    .from("test_subjects")
    .select("subject_id")
    .eq(
      "test_id",
      testId
    );

  if (
    !subjects ||
    !subjects.length
  ) {
    return safeSend(
      chatId,
      "❌ Select at least one subject before publishing."
    );
  }

  const {
    error
  } = await supabase
    .from("tests")
    .update({
      status: "published",
      updated_at:
        new Date().toISOString()
    })
    .eq(
      "id",
      testId
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  await safeSend(
    chatId,
    "🚀 Test published successfully."
  );

  await showTestDetail(
    chatId,
    testId
  );
}

async function endTest(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  if (
    test.status !==
    "published"
  ) {
    return safeSend(
      chatId,
      "❌ Only published tests can be ended."
    );
  }

  const {
    error
  } = await supabase
    .from("tests")
    .update({
      status: "ended",
      updated_at:
        new Date().toISOString()
    })
    .eq(
      "id",
      testId
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  await safeSend(
    chatId,
    "⛔ Test ended."
  );

  await showTestDetail(
    chatId,
    testId
  );
}

/* =========================================================
   ANSWER KEY PLACEHOLDER
========================================================= */

async function answerKeyPlaceholder(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  if (
    test.status !==
    "ended"
  ) {
    return safeSend(
      chatId,
      "🔒 Answer key upload is available after the test ends."
    );
  }

  await safeSend(
    chatId,
`🔑 *Answer Key Upload*

This module is reserved for the next phase.

The database already supports multiple correct options through \`answer_key_options\`.

No answer is collected during Question Builder.`,
    {
      parse_mode: "Markdown"
    }
  );
}

/* =========================================================
   RESULTS PLACEHOLDER
========================================================= */

async function resultsPlaceholder(
  chatId,
  testId
) {
  const test =
    await fetchTest(testId);

  if (!test) {
    return safeSend(
      chatId,
      "❌ Test not found."
    );
  }

  await safeSend(
    chatId,
`📊 *Results*

${escapeMarkdown(test.title)}

Results/scoring module is reserved for the next phase.`,
    {
      parse_mode: "Markdown"
    }
  );
}

/* =========================================================
   ADMIN MANAGEMENT
========================================================= */

async function showAdmins(chatId) {
  const me =
    await getAdmin(chatId);

  if (
    !me ||
    me.role !== "owner"
  ) {
    return safeSend(
      chatId,
      "⛔ Only the owner can manage admins."
    );
  }

  const {
    data,
    error
  } = await supabase
    .from("telegram_admins")
    .select(
      "telegram_user_id,role,is_active,created_at"
    )
    .order("created_at");

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  const lines =
    (data || [])
      .map(
        admin =>
          `${admin.role === "owner" ? "👑" : "👤"} ${admin.telegram_user_id} — ${admin.role} — ${admin.is_active ? "active" : "inactive"}`
      )
      .join("\n");

  const rows = [
    [
      {
        text: "➕ Add Admin",
        callback_data:
          `${CALLBACK_PREFIX}na`
      }
    ]
  ];

  for (
    const admin of
    (data || []).filter(
      item =>
        item.role === "admin" &&
        item.is_active
    )
  ) {
    rows.push([
      {
        text:
          `🔑 Set password ${admin.telegram_user_id}`,
        callback_data:
          `${CALLBACK_PREFIX}sap:${admin.telegram_user_id}`
      },
      {
        text:
          `🚫 Disable ${admin.telegram_user_id}`,
        callback_data:
          `${CALLBACK_PREFIX}da:${admin.telegram_user_id}`
      }
    ]);
  }

  rows.push([
    {
      text: "⬅️ Panel",
      callback_data:
        `${CALLBACK_PREFIX}panel`
    }
  ]);

  await safeSend(
    chatId,
`👥 *Admins*

${lines || "None"}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function startAddAdmin(
  chatId
) {
  const me =
    await getAdmin(chatId);

  if (
    !me ||
    me.role !== "owner"
  ) {
    return safeSend(
      chatId,
      "⛔ Owner only."
    );
  }

  const session =
    getSession(chatId);

  session.state =
    "admin_id";

  session.data = {};

  session.authenticated =
    true;

  await safeSend(
    chatId,
    "Enter the new admin Telegram numeric ID:"
  );
}

async function createAdmin(
  chatId,
  id,
  password
) {
  if (
    !/^\d+$/.test(
      String(id)
    )
  ) {
    return safeSend(
      chatId,
      "❌ Telegram ID must be numeric."
    );
  }

  const numericId =
    Number(id);

  if (
    !Number.isSafeInteger(
      numericId
    ) ||
    numericId <= 0
  ) {
    return safeSend(
      chatId,
      "❌ Invalid Telegram ID."
    );
  }

  if (
    numericId ===
    OWNER_TELEGRAM_ID
  ) {
    return safeSend(
      chatId,
      "❌ Owner ID cannot be added as admin."
    );
  }

  if (
    !password ||
    password.length < 6
  ) {
    return safeSend(
      chatId,
      "❌ Password must be at least 6 characters."
    );
  }

  const {
    error
  } = await supabase
    .from("telegram_admins")
    .upsert({
      telegram_user_id:
        numericId,
      role: "admin",
      password_hash:
        hashPassword(password),
      is_active: true,
      updated_at:
        new Date().toISOString()
    });

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Admin created/activated."
  );

  await showAdmins(chatId);
}

async function startSetAdminPassword(
  chatId,
  adminId
) {
  const me =
    await getAdmin(chatId);

  if (
    !me ||
    me.role !== "owner"
  ) {
    return safeSend(
      chatId,
      "⛔ Owner only."
    );
  }

  const session =
    getSession(chatId);

  session.state =
    "admin_password";

  session.data = {
    adminId:
      Number(adminId)
  };

  session.authenticated =
    true;

  await safeSend(
    chatId,
    `Enter new password for admin ${adminId}:`
  );
}

async function saveAdminPassword(
  chatId,
  password
) {
  const session =
    getSession(chatId);

  if (
    !password ||
    password.length < 6
  ) {
    return safeSend(
      chatId,
      "❌ Password must be at least 6 characters."
    );
  }

  const {
    error
  } = await supabase
    .from("telegram_admins")
    .update({
      password_hash:
        hashPassword(password),
      updated_at:
        new Date().toISOString()
    })
    .eq(
      "telegram_user_id",
      session.data.adminId
    )
    .eq(
      "role",
      "admin"
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  resetSession(chatId);

  getSession(chatId).authenticated =
    true;

  await safeSend(
    chatId,
    "✅ Admin password changed."
  );

  await showAdmins(chatId);
}

async function disableAdmin(
  chatId,
  adminId
) {
  const me =
    await getAdmin(chatId);

  if (
    !me ||
    me.role !== "owner"
  ) {
    return safeSend(
      chatId,
      "⛔ Owner only."
    );
  }

  const {
    error
  } = await supabase
    .from("telegram_admins")
    .update({
      is_active: false,
      updated_at:
        new Date().toISOString()
    })
    .eq(
      "telegram_user_id",
      Number(adminId)
    )
    .eq(
      "role",
      "admin"
    );

  if (error) {
    return safeSend(
      chatId,
      `❌ ${error.message}`
    );
  }

  await safeSend(
    chatId,
    "🚫 Admin disabled."
  );

  await showAdmins(chatId);
}

/* =========================================================
   CALLBACK ROUTER
========================================================= */

async function handleCallback(query) {
  const chatId =
    query.message?.chat?.id;

  if (!chatId) {
    return answerCallback(query);
  }

  const data =
    String(query.data || "");

  await answerCallback(query);

  if (
    !data.startsWith(
      CALLBACK_PREFIX
    )
  ) {
    return;
  }

  const code =
    data.slice(
      CALLBACK_PREFIX.length
    );

  const session =
    getSession(chatId);

  /* -------------------------
     LOGOUT
  ------------------------- */

  if (code === "logout") {
    clearSession(chatId);

    return safeSend(
      chatId,
      "🚪 Logged out. Use /start to authenticate again."
    );
  }

  /* -------------------------
     CANCEL
  ------------------------- */

  if (code === "cancel") {
    resetSession(chatId);

    getSession(chatId).authenticated =
      true;

    return safeSend(
      chatId,
      "❌ Cancelled."
    );
  }

  /* -------------------------
     HELP
  ------------------------- */

  if (code === "help") {
    return showHelp(chatId);
  }

  /*
    Internal callbacks are used while
    an already-authenticated multi-step
    operation is running.
  */

  const internal =
    /^(qtype:|eqt:|tog:|vqp:|vqn:|del:|eqpick:|dqpick:|delpick:)/.test(
      code
    );

  if (
    !session.authenticated &&
    !internal
  ) {
    return beginAuth(
      chatId,
      mapCallbackToAction(code)
    );
  }

  if (
    internal &&
    !session.authenticated
  ) {
    return beginAuth(
      chatId,
      mapCallbackToAction(code)
    );
  }

  try {
    if (code === "panel") {
      return beginAuth(
        chatId,
        "panel"
      );
    }

    if (code === "tests") {
      return beginAuth(
        chatId,
        "tests"
      );
    }

    if (code === "subs") {
      return beginAuth(
        chatId,
        "subs"
      );
    }

    if (code === "admins") {
      return beginAuth(
        chatId,
        "admins"
      );
    }

    if (code === "ct") {
      return beginAuth(
        chatId,
        "create_test"
      );
    }

    if (
      code.startsWith("etm:")
    ) {
      return beginAuth(
        chatId,
        `edit_test:${code.slice(4)}`
      );
    }

    if (
      code.startsWith("et:")
    ) {
      return beginAuth(
        chatId,
        `edit_test:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("ts:")
    ) {
      return beginAuth(
        chatId,
        `subjects:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("qm:")
    ) {
      return beginAuth(
        chatId,
        `questions:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("aq:")
    ) {
      return beginAuth(
        chatId,
        `add_question:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("vq:")
    ) {
      return beginAuth(
        chatId,
        `view_questions:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("eqpick:")
    ) {
      return pickQuestion(
        chatId,
        code.slice(7),
        "eqpick"
      );
    }

    if (
      code.startsWith("dqpick:")
    ) {
      return pickQuestion(
        chatId,
        code.slice(7),
        "dqpick"
      );
    }

    if (
      code.startsWith("pub:")
    ) {
      return beginAuth(
        chatId,
        `publish:${code.slice(4)}`
      );
    }

    if (
      code.startsWith("end:")
    ) {
      return beginAuth(
        chatId,
        `end:${code.slice(4)}`
      );
    }

    if (
      code.startsWith("ak:")
    ) {
      return beginAuth(
        chatId,
        `answer_key:${code.slice(3)}`
      );
    }

    if (
      code.startsWith("rs:")
    ) {
      return beginAuth(
        chatId,
        `results:${code.slice(3)}`
      );
    }

    if (code === "ns") {
      return beginAuth(
        chatId,
        "new_subject"
      );
    }

    if (
      code.startsWith("es:")
    ) {
      return beginAuth(
        chatId,
        `edit_subject:${code.slice(3)}`
      );
    }

    /* -------------------------
       QUESTION TYPE
    ------------------------- */

    if (
      code.startsWith("qtype:")
    ) {
      session.data.questionType =
        code.slice(6);

      session.state =
        "question_text";

      return safeSend(
        chatId,
        "Enter question text:"
      );
    }

    /* -------------------------
       QUESTION PAGINATION
    ------------------------- */

    if (
      code.startsWith("vqp:")
    ) {
      const [
        testId,
        page
      ] =
        code
          .slice(4)
          .split(":");

      return viewQuestions(
        chatId,
        testId,
        Number(page)
      );
    }

    if (
      code.startsWith("vqn:")
    ) {
      const [
        testId,
        page
      ] =
        code
          .slice(4)
          .split(":");

      return viewQuestions(
        chatId,
        testId,
        Number(page)
      );
    }

    /* -------------------------
       DELETE
    ------------------------- */

    if (
      code.startsWith("del:")
    ) {
      return deleteQuestion(
        chatId,
        code.slice(4)
      );
    }

    /* -------------------------
       SUBJECT TOGGLE
    ------------------------- */

    if (
      code.startsWith("tog:")
    ) {
      const [
        testId,
        subjectId
      ] =
        code
          .slice(4)
          .split(":");

      return toggleTestSubject(
        chatId,
        testId,
        subjectId
      );
    }

    /* -------------------------
       QUESTION PICK
    ------------------------- */

    if (
      code.startsWith("eqpick:")
    ) {
      return startEditQuestion(
        chatId,
        code.slice(7)
      );
    }

    if (
      code.startsWith("dqpick:")
    ) {
      return pickQuestion(
        chatId,
        code.slice(7),
        "delpick"
      );
    }

    if (
      code.startsWith("delpick:")
    ) {
      return confirmDeleteQuestion(
        chatId,
        code.slice(8)
      );
    }

    /* -------------------------
       QUESTION EDIT FIELD
    ------------------------- */

    if (
      code.startsWith("eqf:")
    ) {
      const parts =
        code.split(":");

      const field =
        parts[1];

      const questionId =
        parts[2];

      return editQuestionField(
        chatId,
        questionId,
        field
      );
    }

    /* -------------------------
       QUESTION TYPE EDIT
    ------------------------- */

    if (
      code.startsWith("eqt:")
    ) {
      const parts =
        code.split(":");

      const type =
        parts[1];

      const questionId =
        parts[2];

      return changeQuestionType(
        chatId,
        type,
        questionId
      );
    }

    /* -------------------------
       TEST FIELD EDIT
    ------------------------- */

    if (
      code.startsWith("field:")
    ) {
      const parts =
        code.split(":");

      const field =
        parts[1];

      const testId =
        parts[2];

      session.state =
        `edit_test_${field}`;

      session.data = {
        testId,
        field
      };

      return safeSend(
        chatId,
        `Enter new value for ${field}:`
      );
    }

    /* -------------------------
       ADMIN
    ------------------------- */

    if (code === "na") {
      return startAddAdmin(
        chatId
      );
    }

    if (
      code.startsWith("sap:")
    ) {
      return startSetAdminPassword(
        chatId,
        code.slice(4)
      );
    }

    if (
      code.startsWith("da:")
    ) {
      return disableAdmin(
        chatId,
        code.slice(3)
      );
    }
  } catch (error) {
    console.error(
      "callback error:",
      error
    );

    await safeSend(
      chatId,
      "❌ Something went wrong. Try again."
    );
  }
}

/* =========================================================
   CALLBACK -> AUTH ACTION
========================================================= */

function mapCallbackToAction(
  code
) {
  if (code === "tests") {
    return "tests";
  }

  if (code === "subs") {
    return "subs";
  }

  if (code === "admins") {
    return "admins";
  }

  if (code === "ct") {
    return "create_test";
  }

  if (code === "ns") {
    return "new_subject";
  }

  if (
    code.startsWith("et:") ||
    code.startsWith("etm:")
  ) {
    return `edit_test:${code
      .split(":")
      .slice(1)
      .join(":")}`;
  }

  if (code.startsWith("ts:")) {
    return `subjects:${code.slice(3)}`;
  }

  if (code.startsWith("qm:")) {
    return `questions:${code.slice(3)}`;
  }

  if (code.startsWith("aq:")) {
    return `add_question:${code.slice(3)}`;
  }

  if (code.startsWith("vq:")) {
    return `view_questions:${code.slice(3)}`;
  }

  if (code.startsWith("eqpick:")) {
    return `edit_question:${code.slice(7)}`;
  }

  if (code.startsWith("dqpick:")) {
    return `delete_question:${code.slice(7)}`;
  }

  return "panel";
}

/* =========================================================
   TEXT INPUT HANDLER
========================================================= */

async function handleText(msg) {
  const chatId =
    msg.chat.id;

  const text =
    String(msg.text || "")
      .trim();

  if (!text) {
    return;
  }

  const session =
    getSession(chatId);

  /* -------------------------
     CANCEL
  ------------------------- */

  if (text === "/cancel") {
    resetSession(chatId);

    return safeSend(
      chatId,
      "❌ Cancelled. Use /start to authenticate again."
    );
  }

  if (
    text.startsWith("/")
  ) {
    return;
  }

  /* -------------------------
     PASSWORD
  ------------------------- */

  if (
    session.state ===
    "await_password"
  ) {
    const admin =
      await getAdmin(
        msg.from.id
      );

    if (
      !admin ||
      !admin.is_active
    ) {
      return safeSend(
        chatId,
        "⛔ You are not authorized."
      );
    }

    if (
      !verifyPassword(
        text,
        admin.password_hash
      )
    ) {
      return safeSend(
        chatId,
        "❌ Wrong password. Try again."
      );
    }

    session.authenticated =
      true;

    session.state =
      "idle";

    const action =
      session.authAction;

    session.authAction =
      null;

    return runAuthenticatedAction(
      chatId,
      action
    );
  }

  /* -------------------------
     AUTH REQUIRED
  ------------------------- */

  if (!session.authenticated) {
    return safeSend(
      chatId,
      "🔐 Use /start to authenticate."
    );
  }

  try {
    /* =====================================================
       CREATE TEST
    ===================================================== */

    if (
      session.state.startsWith(
        "create_"
      )
    ) {
      if (
        session.state ===
        "create_title"
      ) {
        session.data.title =
          text;

        session.state =
          "create_description";

        return safeSend(
          chatId,
          "Enter description (or type - to skip):"
        );
      }

      if (
        session.state ===
        "create_description"
      ) {
        session.data.description =
          text === "-"
            ? ""
            : text;

        session.state =
          "create_date";

        return safeSend(
          chatId,
          "Enter test date YYYY-MM-DD (or - to skip):"
        );
      }

      if (
        session.state ===
        "create_date"
      ) {
        session.data.testDate =
          text === "-"
            ? ""
            : text;

        session.state =
          "create_time";

        return safeSend(
          chatId,
          "Enter test time HH:MM (or - to skip):"
        );
      }

      if (
        session.state ===
        "create_time"
      ) {
        session.data.testTime =
          text === "-"
            ? ""
            : text;

        session.state =
          "create_duration";

        return safeSend(
          chatId,
          "Enter duration in minutes:"
        );
      }

      if (
        session.state ===
        "create_duration"
      ) {
        const number =
          Number(text);

        if (
          !Number.isInteger(
            number
          ) ||
          number <= 0
        ) {
          return safeSend(
            chatId,
            "❌ Enter a positive integer."
          );
        }

        session.data.duration =
          number;

        session.state =
          "create_marks";

        return safeSend(
          chatId,
          "Enter default marks per question:"
        );
      }

      if (
        session.state ===
        "create_marks"
      ) {
        const number =
          Number(text);

        if (!(number > 0)) {
          return safeSend(
            chatId,
            "❌ Marks must be positive."
          );
        }

        session.data.marksPerQuestion =
          number;

        session.state =
          "create_negative_enabled";

        return safeSend(
          chatId,
          "Enable negative marking? yes/no"
        );
      }

      if (
        session.state ===
        "create_negative_enabled"
      ) {
        const value =
          text.toLowerCase();

        if (
          value !== "yes" &&
          value !== "no"
        ) {
          return safeSend(
            chatId,
            "❌ Type yes or no."
          );
        }

        session.data.negativeEnabled =
          value === "yes";

        session.state =
          "create_negative_value";

        return safeSend(
          chatId,
          "Enter negative marks (0 or positive number):"
        );
      }

      if (
        session.state ===
        "create_negative_value"
      ) {
        const number =
          Number(text);

        if (!(number >= 0)) {
          return safeSend(
            chatId,
            "❌ Invalid negative marks."
          );
        }

        session.data.negativeValue =
          number;

        session.state =
          "create_instructions";

        return safeSend(
          chatId,
          "Enter instructions (or - to skip):"
        );
      }

      if (
        session.state ===
        "create_instructions"
      ) {
        session.data.instructions =
          text === "-"
            ? ""
            : text;

        return createTestFromSession(
          chatId
        );
      }
    }

    /* =====================================================
       EDIT TEST
    ===================================================== */

    if (
      session.state.startsWith(
        "edit_test_"
      )
    ) {
      return saveTestField(
        chatId,
        session.data.testId,
        session.data.field,
        text
      );
    }

    /* =====================================================
       SUBJECT
    ===================================================== */

    if (
      session.state ===
      "subject_new"
    ) {
      return saveNewSubject(
        chatId,
        text
      );
    }

    if (
      session.state ===
      "subject_edit"
    ) {
      return saveEditedSubject(
        chatId,
        session.data.subjectId,
        text
      );
    }

    /* =====================================================
       ADD QUESTION
    ===================================================== */

    const questionStates = [
      "question_text",
      "option_a",
      "option_b",
      "option_c",
      "option_d",
      "question_marks",
      "question_negative"
    ];

    if (
      questionStates.includes(
        session.state
      )
    ) {
      return processQuestionInput(
        chatId,
        text
      );
    }

    /* =====================================================
       EDIT QUESTION
    ===================================================== */

    const editQuestionStates = [
      "edit_text",
      "edit_marks",
      "edit_neg",
      "edit_option_a",
      "edit_option_b",
      "edit_option_c",
      "edit_option_d"
    ];

    if (
      editQuestionStates.includes(
        session.state
      )
    ) {
      return processEditInput(
        chatId,
        text
      );
    }

    /* =====================================================
       ADMIN CREATION
    ===================================================== */

    if (
      session.state ===
      "admin_id"
    ) {
      if (
        !/^\d+$/.test(text)
      ) {
        return safeSend(
          chatId,
          "❌ Enter numeric Telegram ID."
        );
      }

      session.data.adminId =
        Number(text);

      session.state =
        "admin_password";

      return safeSend(
        chatId,
        "Enter password for this admin (minimum 6 characters):"
      );
    }

    if (
      session.state ===
      "admin_password"
    ) {
      if (
        session.data.adminId
      ) {
        return createAdmin(
          chatId,
          session.data.adminId,
          text
        );
      }

      return saveAdminPassword(
        chatId,
        text
      );
    }

    return safeSend(
      chatId,
      "Use the buttons or /start."
    );
  } catch (error) {
    console.error(
      "text error:",
      error
    );

    return safeSend(
      chatId,
      "❌ Something went wrong."
    );
  }
}

/* =========================================================
   COMMANDS
========================================================= */

bot.onText(
  /^\/start$/,
  async msg => {
    await showAdminGate(
      msg.chat.id
    );
  }
);

bot.onText(
  /^\/help$/,
  async msg => {
    const admin =
      await getAdmin(
        msg.from.id
      );

    if (
      !admin ||
      !admin.is_active
    ) {
      return safeSend(
        msg.chat.id,
        "⛔ Admin access required. Use /start."
      );
    }

    await beginAuth(
      msg.chat.id,
      "panel"
    );
  }
);

bot.onText(
  /^\/cancel$/,
  async msg => {
    resetSession(
      msg.chat.id
    );

    await safeSend(
      msg.chat.id,
      "❌ Cancelled."
    );
  }
);

/* =========================================================
   BOT EVENTS
========================================================= */

bot.on(
  "callback_query",
  handleCallback
);

bot.on(
  "message",
  handleText
);

bot.on(
  "polling_error",
  error => {
    console.error(
      "Telegram polling error:",
      error.message
    );
  }
);

/* =========================================================
   PROCESS ERROR HANDLERS
========================================================= */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

/* =========================================================
   STARTUP
========================================================= */

(async () => {
  try {
    await ensureOwnerAccount();

    console.log(
      "🤖 PrepArena Admin Bot is running..."
    );
  } catch (error) {
    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);
  }
})();
