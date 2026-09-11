const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_ID = 8256722518;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
if (!SUPABASE_URL) throw new Error("SUPABASE_URL is not configured");
if (!SUPABASE_SECRET_KEY) throw new Error("SUPABASE_SECRET_KEY is not configured");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const supportSessions = new Set();
const examSessions = new Map(); // chatId -> { testId, participantId, questionIndex, endsAt }

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function safeSend(chatId, text, options = {}) {
  try { return await bot.sendMessage(chatId, text, options); }
  catch (e) { console.error("Telegram send error:", e?.message || e); return null; }
}

async function answerCallback(query, text = "") {
  try { await bot.answerCallbackQuery(query.id, text ? { text } : {}); } catch (_) {}
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📝 Available Tests", callback_data: "tests" }, { text: "📊 My Results", callback_data: "results" }],
      [{ text: "👤 My Profile", callback_data: "profile" }],
      [{ text: "🆘 Support", callback_data: "support" }]
    ]
  };
}

function formatRemaining(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function testStatusLabel(test) {
  if (test.lobby_state === "live") return "🟢 LIVE";
  if (test.lobby_state === "instructions") return "🟡 INSTRUCTIONS";
  if (test.lobby_state === "lobby_live" || test.lobby_state === "ready") return "🟡 LOBBY OPEN";
  if (test.lobby_state === "ended") return test.answer_key_status === "completed" ? "🏁 RESULTS" : "🟠 ANSWER KEY PENDING";
  return "⏳ WAITING FOR HOST";
}

async function getAvailableTests() {
  const { data, error } = await supabase
    .from("tests")
    .select("id,title,description,exam_type,status,test_date,test_time,duration_minutes,total_questions,total_marks,starts_at,ends_at,lobby_state,instruction_countdown_seconds,chat_enabled")
    .eq("status", "published")
    .order("starts_at", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

async function getTest(testId) {
  const { data, error } = await supabase.from("tests").select("*").eq("id", testId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getQuestions(testId) {
  const { data, error } = await supabase
    .from("questions")
    .select("id,test_id,question_number,question_text,question_type,marks,negative_marks,image_file_id")
    .eq("test_id", testId)
    .order("question_number", { ascending: true });
  if (error) throw error;
  const qs = data || [];
  if (!qs.length) return [];
  const ids = qs.map(q => q.id);
  const { data: options, error: oe } = await supabase
    .from("question_options")
    .select("id,question_id,option_label,option_text,option_order")
    .in("question_id", ids)
    .order("option_order", { ascending: true });
  if (oe) throw oe;
  const map = new Map();
  for (const o of options || []) {
    if (!map.has(o.question_id)) map.set(o.question_id, []);
    map.get(o.question_id).push(o);
  }
  return qs.map(q => ({ ...q, options: map.get(q.id) || [] }));
}

async function ensureParticipant(test, msg) {
  const telegramUserId = msg.from.id;
  const username = msg.from.username || null;
  const displayName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "Student";

  const { data: existingRows, error: findError } = await supabase
    .from("participants")
    .select("*")
    .eq("test_id", test.id)
    .eq("telegram_user_id", telegramUserId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (findError) throw findError;
  const existing = existingRows?.[0] || null;
  if (existing && existing.status === "submitted") return existing;
  if (existing) return existing;

  const { data, error } = await supabase
    .from("participants")
    .insert({
      test_id: test.id,
      telegram_user_id: telegramUserId,
      username,
      display_name: displayName,
      status: "joined",
      created_at: new Date().toISOString()
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function markStarted(participantId) {
  const startedAt = new Date().toISOString();
  const { error } = await supabase
    .from("participants")
    .update({ status: "in_progress", started_at: startedAt })
    .eq("id", participantId);
  if (error) throw error;

  const { data, error: fetchError } = await supabase
    .from("participants")
    .select("*")
    .eq("id", participantId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!data) throw new Error("Participant record could not be loaded after starting.");
  return data;
}

async function loadAnswers(participantId) {
  const { data, error } = await supabase
    .from("answers")
    .select("question_id,selected_option_id,selected_option_ids,numeric_answer")
    .eq("participant_id", participantId);
  if (error) throw error;
  const map = new Map();
  for (const a of data || []) map.set(a.question_id, a);
  return map;
}

async function loadVisits(participantId) {
  const { data, error } = await supabase.from("participant_question_visits").select("question_id").eq("participant_id", participantId);
  if (error) { console.error("loadVisits:", error.message); return new Set(); }
  return new Set((data || []).map(x => x.question_id));
}

async function visitQuestion(participantId, questionId) {
  const { error } = await supabase.from("participant_question_visits").upsert(
    { participant_id: participantId, question_id: questionId, visited_at: new Date().toISOString() },
    { onConflict: "participant_id,question_id" }
  );
  if (error) console.error("Visit save error:", error.message);
}

async function saveSingleAnswer(participantId, questionId, selectedOptionId, numericAnswer) {
  const payload = {
    participant_id: participantId,
    question_id: questionId,
    selected_option_id: selectedOptionId || null,
    numeric_answer: numericAnswer == null ? null : String(numericAnswer),
    answered_at: new Date().toISOString()
  };
  const { data: existing } = await supabase
    .from("answers")
    .select("id")
    .eq("participant_id", participantId)
    .eq("question_id", questionId)
    .maybeSingle();
  if (existing?.id) {
    const { error } = await supabase.from("answers").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("answers").insert(payload);
    if (error) throw error;
  }
}

async function saveMultiAnswer(participantId, questionId, optionIds) {
  const ids = [...new Set(optionIds)].filter(Boolean);
  const { data: existing } = await supabase
    .from("answers")
    .select("id")
    .eq("participant_id", participantId)
    .eq("question_id", questionId)
    .maybeSingle();
  const payload = {
    participant_id: participantId,
    question_id: questionId,
    selected_option_id: ids[0] || null,
    selected_option_ids: ids,
    numeric_answer: null,
    answered_at: new Date().toISOString()
  };
  if (existing?.id) {
    const { error } = await supabase.from("answers").update(payload).eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("answers").insert(payload);
    if (error) throw error;
  }
}

// Telegram callback_data is limited to 64 bytes. UUID + UUID option callbacks
// exceed that limit, so question/option callbacks use compact UUID encoding.
function encodeUuid(uuid) {
  const hex = String(uuid || "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return Buffer.from(hex, "hex").toString("base64url");
}

function decodeUuid(value) {
  try {
    const text = String(value || "");
    if (!/^[A-Za-z0-9_-]{22}$/.test(text)) return null;
    const hex = Buffer.from(text, "base64url").toString("hex");
    if (hex.length !== 32) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

function callbackForTest(testId) { return `t:${testId}`; }
function callbackForQuestion(testId, index) { return `q:${testId}:${index}`; }
function callbackForOption(testId, index, optionId) {
  return `o:${encodeUuid(testId)}:${index}:${encodeUuid(optionId)}`;
}
function callbackForNav(testId, index) { return `n:${testId}:${index}`; }
function callbackForMultiToggle(testId, index, optionId) {
  return `m:${encodeUuid(testId)}:${index}:${encodeUuid(optionId)}`;
}

async function showAvailableTests(chatId) {
  try {
    const tests = await getAvailableTests();
    if (!tests.length) {
      await safeSend(chatId, "📝 <b>Available Tests</b>\n\nAbhi koi published test available nahi hai.\n\nAdmin ke publish/start karte hi test yahan dikhega. 🚀", { parse_mode: "HTML", reply_markup: mainKeyboard() });
      return;
    }
    const rows = [];
    for (const t of tests) {
      rows.push([{ text: `${testStatusLabel(t)} • ${String(t.title).slice(0, 45)}`, callback_data: callbackForTest(t.id) }]);
    }
    rows.push([{ text: "⬅️ Back", callback_data: "home" }]);
    await safeSend(chatId, `📝 <b>Available Tests</b>\n\n${tests.length} test${tests.length === 1 ? "" : "s"} available:`, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } });
  } catch (e) {
    console.error("showAvailableTests:", e);
    await safeSend(chatId, "❌ Tests load nahi ho paaye. Database connection check karo.");
  }
}

async function showTestLobby(chatId, testId, fromUser) {
  try {
    const test = await getTest(testId);
    if (!test || test.status !== "published") {
      await safeSend(chatId, "❌ Ye test ab available nahi hai.");
      return;
    }
    if (test.lobby_state === "ended") {
      await safeSend(chatId, `🏁 <b>${esc(test.title)}</b>\n\n${test.answer_key_status === "completed" ? "✅ Results published. Open My Results to see your score and rank." : "🟠 Answer Key Update Pending\n\nTest complete ho chuka hai. Answer key upload hone ke baad marks aur rank calculate honge."}`, { parse_mode:"HTML", reply_markup:{inline_keyboard:[[{text:"📊 My Results",callback_data:"results"}],[{text:"⬅️ Back to Tests",callback_data:"tests"}]]} });
      return;
    }
    const subjects = await supabase.from("test_subjects").select("subject_id").eq("test_id", test.id);
    let subjectNames = [];
    if (!subjects.error && subjects.data?.length) {
      const ids = subjects.data.map(x => x.subject_id);
      const s = await supabase.from("subjects").select("name").in("id", ids).order("name");
      subjectNames = (s.data || []).map(x => x.name);
    }
    const p = await ensureParticipant(test, { from: fromUser });
    const now = Date.now();
    const starts = test.starts_at ? new Date(test.starts_at).getTime() : null;
    const isLive = test.lobby_state === "live";
    let stateText = "⏳ <b>Waiting for Host</b>\n\nTest published hai. Host ke Start Test press karne ka wait karo.";
    if (isLive) stateText = "🟢 <b>Test is Live</b>\n\nYou can start the test now.";
    else if (starts && starts > now) stateText += `\n\n🕒 Scheduled: ${new Date(starts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
    const text = `📝 <b>${esc(test.title)}</b>\n\n` +
      `${stateText}\n\n` +
      `📚 Subjects: ${esc(subjectNames.join(", ") || "Not specified")}\n` +
      `❓ Questions: ${Number(test.total_questions || 0)}\n` +
      `🎯 Total Marks: ${Number(test.total_marks || 0)}\n` +
      `⏱ Duration: ${Number(test.duration_minutes || 0)} min`;
    const buttons = [];
    if (isLive) buttons.push([{ text: p.status === "in_progress" ? "▶️ Resume Test" : "🚀 Start Test", callback_data: `start:${test.id}` }]);
    else buttons.push([{ text: "🔄 Refresh Status", callback_data: callbackForTest(test.id) }]);
    buttons.push([{ text: "⬅️ Back to Tests", callback_data: "tests" }]);
    await safeSend(chatId, text, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("showTestLobby:", e);
    await safeSend(chatId, "❌ Test load nahi ho paaya.");
  }
}

async function renderQuestion(chatId, testId, index) {
  const session = examSessions.get(chatId);
  if (!session || session.testId !== testId) { await safeSend(chatId, "❌ Test session expired. /tests se dobara open karo."); return; }
  const test = await getTest(testId);
  if (!test || test.lobby_state === "ended") { await safeSend(chatId, "🔴 Test has ended."); await autoSubmit(chatId, "host ended test"); return; }
  const questions = await getQuestions(testId);
  if (!questions.length) { await safeSend(chatId, "❌ Is test me abhi questions nahi hain."); return; }
  if (index < 0 || index >= questions.length) index = 0;
  session.questionIndex = index;
  const q = questions[index];
  const answers = await loadAnswers(session.participantId);
  const visits = await loadVisits(session.participantId);
  await visitQuestion(session.participantId, q.id);
  visits.add(q.id);
  const answer = answers.get(q.id);
  const remaining = session.endsAt ? new Date(session.endsAt).getTime() - Date.now() : 0;
  if (remaining <= 0) { await autoSubmit(chatId, "timer ended"); return; }

  let body = `📝 <b>Question ${index + 1}/${questions.length}</b>\n\n`;
  body += `⏳ <b>${formatRemaining(remaining)}</b>\n\n`;
  body += `${esc(q.question_text)}\n\n`;
  const kb = [];
  if (q.question_type === "numerical") {
    body += answer?.numeric_answer ? `🔢 Answer saved: <b>${esc(answer.numeric_answer)}</b>\n\n` : "🔢 Numerical answer: send it as a message.\n\n";
  } else {
    const selectedIds = new Set(answer?.selected_option_ids || (answer?.selected_option_id ? [answer.selected_option_id] : []));
    for (const o of q.options) {
      const selected = selectedIds.has(o.id);
      kb.push([{ text: `${selected ? "☑️" : "⬜"} ${o.option_label}. ${String(o.option_text).slice(0, 45)}`, callback_data: q.question_type === "multiple_correct" ? callbackForMultiToggle(testId, index, o.id) : callbackForOption(testId, index, o.id) }]);
    }
  }
  // Navigator: every question number, with state colors.
  const nav = [];
  for (let i = 0; i < questions.length; i++) {
    const qq = questions[i];
    const aa = answers.get(qq.id);
    const attempted = Boolean(aa?.selected_option_id || aa?.numeric_answer || (aa?.selected_option_ids && aa.selected_option_ids.length));
    const visited = visits.has(qq.id) || i === index;
    const color = attempted ? "🟩" : visited ? "🟥" : "⬜";
    nav.push({ text: `${color}${i + 1}`, callback_data: callbackForNav(testId, i) });
  }
  for (let i = 0; i < nav.length; i += 5) kb.push(nav.slice(i, i + 5));
  const totalDuration = Number(test.duration_minutes || 0) * 60000;
  const startTime = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
  const submitAllowed = Date.now() - startTime >= totalDuration * (2 / 3);
  if (submitAllowed) kb.push([{ text: "✅ Submit Test", callback_data: `submit:${testId}` }]);
  else kb.push([{ text: "🔒 Submit unlocks after 2/3 time", callback_data: "noop" }]);
  kb.push([{ text: "🏠 Exit Test", callback_data: `exit:${testId}` }]);
  if (q.image_file_id) {
    try {
      await bot.sendPhoto(chatId, q.image_file_id, { caption: `🖼️ Question ${index + 1}/${questions.length}`, parse_mode: "HTML" });
    } catch (e) { console.error("question photo:", e?.message || e); }
  }
  await safeSend(chatId, body, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
}

async function startExam(chatId, testId, msgFrom) {
  try {
    const test = await getTest(testId);
    if (!test || test.status !== "published" || test.lobby_state === "ended") { await safeSend(chatId, "❌ Test is not available."); return; }
    if (test.lobby_state !== "live") { await safeSend(chatId, "⏳ Host ne abhi test start nahi kiya hai."); return; }
    const p = await ensureParticipant(test, { from: msgFrom });
    if (p.status === "submitted") { await safeSend(chatId, "📊 You have already submitted this test."); return; }
    let participant = p;
    if (p.status !== "in_progress") {
      try { participant = await markStarted(p.id); }
      catch (e) {
        console.error("markStarted:", e?.message || e);
        participant = { ...p, status: "in_progress", started_at: new Date().toISOString() };
      }
    }
    const questions = await getQuestions(testId);
    if (!questions.length) { await safeSend(chatId, "❌ Test me questions nahi hain."); return; }
    let endsAt = test.ends_at;
    if (!endsAt) {
      const base = participant.started_at ? new Date(participant.started_at).getTime() : Date.now();
      endsAt = new Date(base + Number(test.duration_minutes || 0) * 60000).toISOString();
    }
    examSessions.set(chatId, { testId, participantId: participant.id, questionIndex: 0, startedAt: participant.started_at, endsAt });
    await safeSend(chatId, `🚀 <b>${esc(test.title)}</b>\n\nTest started. Timer is running continuously.\n\n🟢 Attempted\n🟥 Visited but not attempted\n⬜ Not visited`, { parse_mode: "HTML" });
    await renderQuestion(chatId, testId, 0);
  } catch (e) {
    console.error("startExam:", e?.message || e);
    await safeSend(chatId, "❌ Test start nahi ho paaya. Please try again.");
  }
}

async function handleOption(chatId, testId, index, optionId, multi) {
  const session = examSessions.get(chatId);
  if (!session || session.testId !== testId) return;
  const qs = await getQuestions(testId);
  const q = qs[index];
  if (!q) return;
  if (multi) {
    const answers = await loadAnswers(session.participantId);
    const current = new Set(answers.get(q.id)?.selected_option_ids || (answers.get(q.id)?.selected_option_id ? [answers.get(q.id).selected_option_id] : []));
    if (current.has(optionId)) current.delete(optionId); else current.add(optionId);
    await saveMultiAnswer(session.participantId, q.id, [...current]);
  } else {
    await saveSingleAnswer(session.participantId, q.id, optionId, null);
    if (index + 1 < qs.length) session.questionIndex = index + 1;
  }
  await renderQuestion(chatId, testId, session.questionIndex);
}

async function handleNumericalMessage(msg) {
  const chatId = msg.chat.id;
  const session = examSessions.get(chatId);
  if (!session || !msg.text || msg.text.startsWith("/")) return false;
  const qs = await getQuestions(session.testId);
  const q = qs[session.questionIndex];
  if (!q || q.question_type !== "numerical") return false;
  const value = msg.text.trim();
  if (!/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(value)) {
    await safeSend(chatId, "🔢 Valid numerical value bhejo, e.g. 2, -3.5, 1.25e2");
    return true;
  }
  await saveSingleAnswer(session.participantId, q.id, null, value);
  if (session.questionIndex + 1 < qs.length) session.questionIndex++;
  await renderQuestion(chatId, session.testId, session.questionIndex);
  return true;
}

async function submitExam(chatId, reason = "student submitted") {
  const session = examSessions.get(chatId);
  if (!session) { await safeSend(chatId, "❌ No active test."); return; }
  const test = await getTest(session.testId);
  if (!test) return;
  const p = await supabase.from("participants").select("*").eq("id", session.participantId).maybeSingle();
  if (p.data?.status === "submitted") { examSessions.delete(chatId); return; }
  const now = new Date().toISOString();
  const { error: pe } = await supabase.from("participants").update({ status: "submitted", submitted_at: now }).eq("id", session.participantId);
  if (pe) console.error("participant submit:", pe.message);

  // Grade only when answer keys exist. The admin can add keys later; no answers are exposed to students.
  try {
    const { data: qs } = await supabase.from("questions").select("id,marks,negative_marks,question_type").eq("test_id", test.id);
    const qlist = qs || [];
    const ids = qlist.map(q => q.id);
    const { data: keys } = ids.length ? await supabase.from("answer_keys").select("question_id,correct_option_id,correct_option_ids,correct_numeric_value").in("question_id", ids) : { data: [] };
    const keyMap = new Map((keys || []).map(k => [k.question_id, k]));
    const { data: ans } = await supabase.from("answers").select("question_id,selected_option_id,selected_option_ids,numeric_answer").eq("participant_id", session.participantId);
    let score = 0, correct = 0, wrong = 0, attempted = 0;
    for (const q of qlist) {
      const a = (ans || []).find(x => x.question_id === q.id);
      const k = keyMap.get(q.id);
      if (!a || (!a.selected_option_id && !a.numeric_answer && !(a.selected_option_ids || []).length)) continue;
      attempted++;
      if (!k) continue;
      let ok = false;
      if (q.question_type === "multiple_correct") {
        const got = [...new Set(a.selected_option_ids || (a.selected_option_id ? [a.selected_option_id] : []))].sort();
        const expected = [...new Set(k.correct_option_ids || (k.correct_option_id ? [k.correct_option_id] : []))].sort();
        ok = got.length === expected.length && got.every((v, i) => v === expected[i]);
      } else if (q.question_type === "numerical") {
        ok = String(a.numeric_answer ?? "").trim() === String(k.correct_numeric_value ?? "").trim();
      } else {
        ok = a.selected_option_id === k.correct_option_id;
      }
      if (ok) { correct++; score += Number(q.marks || 0); }
      else { wrong++; score -= Number(q.negative_marks || 0); }
    }
    if (keys?.length) {
      await supabase.from("results").upsert({
        participant_id: session.participantId,
        test_id: test.id,
        telegram_user_id: Number((await bot.getChat(chatId)).id),
        score,
        total_marks: Number(test.total_marks || 0),
        correct_count: correct,
        wrong_count: wrong,
        unattempted_count: Math.max(0, qlist.length - attempted),
        created_at: now
      }, { onConflict: "participant_id" });
    }
  } catch (e) { console.error("grading:", e?.message || e); }
  examSessions.delete(chatId);
  await safeSend(chatId, `🏁 <b>Test Submitted</b>\n\nYour test has been submitted successfully.\n\n${reason === "timer ended" ? "⏰ Timer ended, so the test was auto-submitted." : "Your answers have been saved."}\n\n📊 Results will appear after answer-key evaluation.`, { parse_mode: "HTML", reply_markup: mainKeyboard() });
}

async function autoSubmit(chatId, reason) { await submitExam(chatId, reason); }

async function confirmSubmit(chatId, testId) {
  const session = examSessions.get(chatId);
  if (!session) return;
  const remaining = new Date(session.endsAt).getTime() - Date.now();
  await safeSend(chatId, `⚠️ <b>Submit Test?</b>\n\nTimer remaining: <b>${formatRemaining(remaining)}</b>\n\nSubmit karne ke baad test reopen nahi hoga.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [
    [{ text: "✅ Yes, Submit", callback_data: `yesubmit:${testId}` }, { text: "❌ No, Continue", callback_data: `no_submit:${testId}` }]
  ] } });
}

async function showResults(chatId, telegramUserId) {
  const { data, error } = await supabase.from("results").select("test_id,score,total_marks,correct_count,wrong_count,unattempted_count,rank,percentage,created_at").eq("telegram_user_id", telegramUserId).order("created_at", { ascending: false }).limit(10);
  if (error) { console.error(error); await safeSend(chatId, "❌ Results load nahi ho paaye."); return; }
  if (!data?.length) { await safeSend(chatId, "📊 <b>My Results</b>\n\nAbhi koi results available nahi hain.\n\nTest complete karne ke baad yahan dikhenge.", { parse_mode: "HTML", reply_markup: mainKeyboard() }); return; }
  const ids = [...new Set(data.map(r => r.test_id))];
  const { data: tests } = await supabase.from("tests").select("id,title").in("id", ids);
  const names = new Map((tests || []).map(t => [t.id, t.title]));
  const lines = data.map((r, i) => `${i + 1}. <b>${esc(names.get(r.test_id) || "Test")}</b>\n   Score: ${r.score ?? "-"}/${r.total_marks ?? "-"} • Correct: ${r.correct_count ?? 0} • Wrong: ${r.wrong_count ?? 0} • Rank: ${r.rank ?? "-"}`);
  await safeSend(chatId, `📊 <b>My Results</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: mainKeyboard() });
}

// START
bot.onText(/\/start/, async (msg) => {
  await safeSend(msg.chat.id, "👋 Welcome to <b>PrepArena</b>!\n\nPrepare • Practice • Perform 🚀\n\nWhat would you like to do?", { parse_mode: "HTML", reply_markup: mainKeyboard() });
});

bot.onText(/\/help/, async (msg) => {
  await safeSend(msg.chat.id, "📚 <b>PrepArena Help</b>\n\n/tests - View available tests\n/results - View your results\n/profile - View your profile\n/support - Contact PrepArena Support\n/cancel - Exit current support/test screen", { parse_mode: "HTML", reply_markup: mainKeyboard() });
});

bot.onText(/\/tests/, async (msg) => showAvailableTests(msg.chat.id));
bot.onText(/\/results/, async (msg) => showResults(msg.chat.id, msg.from.id));
bot.onText(/\/profile/, async (msg) => {
  const name = msg.from.first_name || "Student";
  const username = msg.from.username ? `@${msg.from.username}` : "Not set";
  await safeSend(msg.chat.id, `👤 <b>My Profile</b>\n\nName: ${esc(name)}\nUsername: ${esc(username)}\nTelegram ID: ${msg.from.id}\n\nPrepArena 🚀`, { parse_mode: "HTML", reply_markup: mainKeyboard() });
});
bot.onText(/\/support/, async (msg) => {
  supportSessions.add(msg.chat.id);
  await safeSend(msg.chat.id, "🆘 <b>PrepArena Support</b>\n\nApni problem/message bhejo. Main ise PrepArena Admin tak forward kar dunga.\n\n❌ /cancel", { parse_mode: "HTML" });
});
bot.onText(/\/cancel/, async (msg) => {
  supportSessions.delete(msg.chat.id);
  if (examSessions.has(msg.chat.id)) { await safeSend(msg.chat.id, "ℹ️ Test screen se exit kar rahe ho. Test submission nahi hua."); examSessions.delete(msg.chat.id); }
  else await safeSend(msg.chat.id, "❌ Current operation cancelled.", { reply_markup: mainKeyboard() });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  const d = query.data || "";
  try {
    if (d === "home") { await answerCallback(query); await safeSend(chatId, "🏠 <b>PrepArena</b>\n\nChoose an action:", { parse_mode: "HTML", reply_markup: mainKeyboard() }); return; }
    if (d === "tests") { await answerCallback(query); await showAvailableTests(chatId); return; }
    if (d === "results") { await answerCallback(query); await showResults(chatId, query.from.id); return; }
    if (d === "profile") { await answerCallback(query); const name = query.from.first_name || "Student"; const username = query.from.username ? `@${query.from.username}` : "Not set"; await safeSend(chatId, `👤 <b>My Profile</b>\n\nName: ${esc(name)}\nUsername: ${esc(username)}\nTelegram ID: ${query.from.id}`, { parse_mode: "HTML", reply_markup: mainKeyboard() }); return; }
    if (d === "support") { await answerCallback(query); supportSessions.add(chatId); await safeSend(chatId, "🆘 <b>PrepArena Support</b>\n\nApni problem/message bhejo.\n\n❌ /cancel", { parse_mode: "HTML" }); return; }
    if (d === "noop") { await answerCallback(query, "Submit 2/3 duration ke baad unlock hoga."); return; }
    if (d.startsWith("t:")) { await answerCallback(query); await showTestLobby(chatId, d.slice(2), query.from); return; }
    if (d.startsWith("start:")) { await answerCallback(query); await startExam(chatId, d.slice(6), query.from); return; }
    if (d.startsWith("q:")) { await answerCallback(query); const [_, testId, idx] = d.split(":"); await renderQuestion(chatId, testId, Number(idx)); return; }
    if (d.startsWith("n:")) { await answerCallback(query); const [_, testId, idx] = d.split(":"); await renderQuestion(chatId, testId, Number(idx)); return; }
    if (d.startsWith("o:")) {
      await answerCallback(query);
      const [_, compactTestId, idx, compactOptionId] = d.split(":");
      const testId = decodeUuid(compactTestId);
      const optionId = decodeUuid(compactOptionId);
      if (!testId || !optionId) { await safeSend(chatId, "❌ Invalid answer button."); return; }
      await handleOption(chatId, testId, Number(idx), optionId, false);
      return;
    }
    if (d.startsWith("m:")) {
      await answerCallback(query);
      const [_, compactTestId, idx, compactOptionId] = d.split(":");
      const testId = decodeUuid(compactTestId);
      const optionId = decodeUuid(compactOptionId);
      if (!testId || !optionId) { await safeSend(chatId, "❌ Invalid answer button."); return; }
      await handleOption(chatId, testId, Number(idx), optionId, true);
      return;
    }
    if (d.startsWith("submit:")) { await answerCallback(query); await confirmSubmit(chatId, d.slice(7)); return; }
    if (d.startsWith("yesubmit:")) { await answerCallback(query); await submitExam(chatId, "student submitted"); return; }
    if (d.startsWith("no_submit:")) { await answerCallback(query); await renderQuestion(chatId, d.slice(10), examSessions.get(chatId)?.questionIndex || 0); return; }
    if (d.startsWith("exit:")) { await answerCallback(query); examSessions.delete(chatId); await safeSend(chatId, "ℹ️ Test screen closed. Submission nahi hua.", { reply_markup: mainKeyboard() }); return; }
  } catch (e) {
    console.error("callback:", e?.message || e);
    await answerCallback(query, "Something went wrong");
    await safeSend(chatId, "❌ Something went wrong. Please try again.");
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  if (await handleNumericalMessage(msg)) return;
  if (!supportSessions.has(chatId)) return;
  const name = msg.from.first_name || "Unknown";
  const username = msg.from.username ? `@${msg.from.username}` : "Not set";
  const adminMessage = `🆘 NEW PREPARENA SUPPORT REQUEST\n\n👤 Name: ${name}\n🔹 Username: ${username}\n🆔 Telegram ID: ${msg.from.id}\n\n💬 Message:\n${msg.text}`;
  await safeSend(ADMIN_ID, adminMessage);
  await safeSend(chatId, "✅ Your message has been forwarded to PrepArena Support.", { reply_markup: mainKeyboard() });
  supportSessions.delete(chatId);
});

// Server-side timer watcher: authoritative end time comes from tests.ends_at.
setInterval(async () => {
  for (const [chatId, session] of examSessions.entries()) {
    try {
      const test = await getTest(session.testId);
      if (!test || test.lobby_state === "ended" || (session.endsAt && new Date(session.endsAt).getTime() <= Date.now())) {
        await autoSubmit(chatId, test?.lobby_state === "ended" ? "test ended" : "timer ended");
      }
    } catch (e) { console.error("timer watcher:", e?.message || e); }
  }
}, 1000);

console.log("🤖 PrepArena Student Bot is running with Supabase test engine...");
