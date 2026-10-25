// Supabase Edge Function：linebot（原始碼）
// 不要直接貼這個檔。執行 `node backend/linebot/build.mjs` 會把規則引擎與資料檔併進來，產生 index.ts，貼那個。
// 接收 LINE 官方帳號的訊息：用聊天室下方的選單圖一題一題作答，答完走和網頁問卷同一套規則引擎。
// 兩種呼叫：LINE 伺服器（帶 X-Line-Signature）與審核者的管理動作（帶 LINE ID token）。
import { createClient } from "npm:@supabase/supabase-js@2";

// @@ENGINE@@

// @@DATA@@

const LINE_CHANNEL_ID = "2012160129"; // LINE Login 頻道（網頁登入用），驗審核者的 ID token
const CONSENT_VERSION = "intake-v1";
const ADMINS = (Deno.env.get("ADMIN_LINE_SUBS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LIFF_URL = "https://liff.line.me/2012160129-CwL40nTW";
const ASSET_BASE = Deno.env.get("ASSET_BASE") ?? "https://herbertlien.github.io/rppg-web/menus/";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// 管理動作從審核頁（網頁）呼叫，需要 CORS；LINE 伺服器不受影響
const cors = {
  "Access-Control-Allow-Origin": "https://herbertlien.github.io",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// ---------- LINE API ----------
async function line(path: string, method = "POST", body?: unknown, host = "api.line.me") {
  const r = await fetch(`https://${host}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`LINE ${method} ${path} ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const reply = (replyToken: string, messages: unknown[]) => line("/v2/bot/message/reply", "POST", { replyToken, messages });

async function verifySignature(raw: string, sig: string | null): Promise<boolean> {
  if (!sig || !SECRET) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return btoa(String.fromCharCode(...mac)) === sig;
}

async function verifyIdToken(idToken: string): Promise<string | null> {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.sub === "string" ? j.sub : null;
}

// ---------- 使用者與同意 ----------
async function findUser(sub: string, create: boolean): Promise<string | null> {
  const found = await db.from("users").select("id").eq("line_sub", sub).maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id;
  if (!create) return null;
  const ins = await db.from("users").insert({ line_sub: sub }).select("id").single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

async function hasConsent(uid: string): Promise<boolean> {
  const c = await db.from("consents").select("id").eq("user_id", uid).eq("version", CONSENT_VERSION).limit(1);
  if (c.error) throw c.error;
  return !!c.data?.length;
}

// ---------- 題目流程 ----------
type Opt = { value: string; label: string; chip?: string; exclusive?: boolean; reject?: string };
type Q = { id: string; type: "single" | "multi"; text: string; hint?: string; max?: number; options: Opt[] };
const QS: Q[] = DATA.questions.questions;
const QTOTAL = QS.length;

function nextQuestion(answers: Record<string, unknown>, afterId: string | null): Q | null {
  const start = afterId ? QS.findIndex((q) => q.id === afterId) + 1 : 0;
  for (let i = start; i < QS.length; i++) if (isShown(QS[i], answers)) return QS[i];
  return null;
}

type Session = { user_id: string; answers: Record<string, unknown>; cur: string | null; multi: string[]; history: string[] };

async function loadSession(uid: string): Promise<Session | null> {
  const r = await db.from("quiz_sessions").select("*").eq("user_id", uid).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}
async function saveSession(s: Session) {
  const r = await db.from("quiz_sessions").upsert({ ...s, updated_at: new Date().toISOString() });
  if (r.error) throw r.error;
}
async function clearSession(uid: string) {
  const r = await db.from("quiz_sessions").delete().eq("user_id", uid);
  if (r.error) throw r.error;
}

const quick = (items: { label: string; data?: string; text?: string; uri?: string }[]) => ({
  items: items.map((i) => ({
    type: "action",
    action: i.uri
      ? { type: "uri", label: i.label.slice(0, 20), uri: i.uri }
      : i.data
      ? { type: "postback", label: i.label.slice(0, 20), data: i.data, displayText: i.label.slice(0, 20) }
      : { type: "message", label: i.label.slice(0, 20), text: i.text ?? i.label },
  })),
});

async function menuIds(): Promise<Record<string, string>> {
  const r = await db.from("rich_menus").select("question_id,rich_menu_id,questions_version");
  if (r.error) throw r.error;
  return Object.fromEntries((r.data ?? []).filter((x: { questions_version: string }) => x.questions_version === DATA.questions.version)
    .map((x: { question_id: string; rich_menu_id: string }) => [x.question_id, x.rich_menu_id]));
}

// 送出目前這一題：換上這一題的選單圖
async function askQuestion(sub: string, replyToken: string, s: Session, notice?: string, intro = false) {
  const q = QS.find((x) => x.id === s.cur)!;
  const n = QS.filter((x) => isShown(x, s.answers)).indexOf(q) + 1;
  const total = QS.filter((x) => isShown(x, s.answers)).length;
  const text = `（${n}/${total}）${q.text}${q.hint ? `\n${q.hint}` : ""}${q.type === "multi" ? `\n${q.max ? `最多選 ${q.max} 項。` : ""}點選項加入、再點一次取消，選好請按選單最下面的「完成」。${q.options.some((o) => o.exclusive) ? "都沒有的話，直接按「完成」就可以。" : ""}` : ""}`;
  const back = s.history.length ? [{ label: "‹ 上一題", data: "back" }] : [];
  const messages: unknown[] = [];
  if (notice) messages.push({ type: "text", text: notice });
  if (intro) messages.push({ type: "image", originalContentUrl: `${ASSET_BASE}intro.png`, previewImageUrl: `${ASSET_BASE}intro.png` });
  // 單選、複選都用下方選單圖；複選的選單最下面有「完成」，點選項只回報目前選了什麼，選單不換
  const ids = await menuIds();
  if (ids[q.id]) await line(`/v2/bot/user/${sub}/richmenu/${ids[q.id]}`);
  else await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
  messages.push({ type: "text", text, ...(back.length ? { quickReply: quick(back) } : {}) });
  await reply(replyToken, messages);
}

const CONSENT_TEXT = "開始前請先看一下：\n接下來會問你年齡、是否懷孕或用藥、過敏、目前吃的保健食品，以及作息與飲食習慣，用來整理適合你的每日組合。\n・回答只有 Deerly 負責審核的人看得到，不會提供給第三方。\n・如果依回答我們不適合提供服務，這次的回答不會被保存。\n・如果你也用過心率量測，量測的數字（沒有影像）會一起給審核者參考。\n・配方由固定規則整理，再由人工確認後才通知你；這不是醫療建議。\n・你隨時可以刪除所有資料。\n（草稿，正式對外前會請專業人士審閱）";

async function startFlow(sub: string, replyToken: string, force = false) {
  if(relaxMenuTestScope()){
    const priorUid=await findUser(sub,false),prior=priorUid?await relaxSession(priorUid):null;
    if(prior)await relaxMenusRestore(sub,prior);
  }
  const uid = await findUser(sub, true);
  if (!uid) return;
  if (!(await hasConsent(uid))) {
    return reply(replyToken, [{
      type: "text", text: CONSENT_TEXT,
      quickReply: quick([{ label: "我同意，開始", data: "consent|yes" }, { label: "先不要", data: "consent|no" }]),
    }]);
  }
  if (!force) {
    // 還有沒答完的問卷（已經答過至少一題）時，先問要繼續還是重來，不要直接清掉進度
    const old = await loadSession(uid);
    if (old?.cur && old.history.length) {
      return reply(replyToken, [{
        type: "text", text: `你有一份還沒答完的問卷（已答 ${old.history.length} 題）。要繼續，還是重新開始？`,
        quickReply: quick([{ label: "繼續", data: "resume|go" }, { label: "重新開始", data: "restart|go" }]),
      }]);
    }
  }
  const first = nextQuestion({}, null)!;
  const s: Session = { user_id: uid, answers: {}, cur: first.id, multi: [], history: [] };
  await saveSession(s);
  await askQuestion(sub, replyToken, s, "好的，我們開始，大約兩分鐘。", true);
}

async function finish(sub: string, replyToken: string, s: Session) {
  await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
  const result = buildPack(s.answers, DATA);
  await clearSession(s.user_id);
  if (result.status === "invalid") return reply(replyToken, [{ type: "text", text: "資料有些問題，請輸入「開始問卷」重新來一次，不好意思。" }]);
  if (result.status === "rejected") return reply(replyToken, result.messages.map((t: string) => ({ type: "text", text: t })));
  const clean = Object.fromEntries(QS.map((q) => [q.id, s.answers[q.id]]));
  const it = await db.from("intakes").insert({ user_id: s.user_id, questions_version: DATA.questions.version, answers: clean }).select("id").single();
  if (it.error) throw it.error;
  const pk = await db.from("packs").insert({
    intake_id: it.data.id, user_id: s.user_id, engine_version: result.engineVersion, data_version: result.dataVersion,
    result, item_ids: result.items.map((i: { id: string }) => i.id), status: "needs_review",
  });
  if (pk.error) throw pk.error;
  return reply(replyToken, [
    { type: "text", text: "謝謝你！這是依你的回答整理的專屬報告。品項我們確認後，會在這裡通知你。" },
    reportFlexV2(buildReport(result, s.answers, DATA)),
  ]);
}

// ---------- 專屬報告（LINE Flex 卡片）----------
type Report = { focus: { label: string; because: string[] }[]; taking: string[]; tier: number; avoided: string[]; safety: string; tip: string | null; diet?: string | null };
const T = (text: string, o: Record<string, unknown> = {}) => ({ type: "text", text, wrap: true, ...o });
const bubble = (title: string, lines: unknown[], footer?: unknown) => ({
  type: "bubble", size: "mega",
  styles: { body: { backgroundColor: "#F6F1EA" }, footer: { backgroundColor: "#F6F1EA" } },
  body: { type: "box", layout: "vertical", spacing: "lg", paddingAll: "20px", contents: [
    T("DEERLY 專屬報告", { size: "xs", weight: "bold", color: "#2F7D5B" }),
    T(title, { size: "xl", weight: "bold", color: "#1E2A24" }),
    ...lines,
  ] },
  ...(footer ? { footer } : {}),
});

// ---------- 新版卡片視覺（頁頭圖＋圓角數字＋圓點）----------
const CARD_HEADER = "https://herbertlien.github.io/rppg-web/cards/header.png";
const C = { bg: "#FCF8EF", deep: "#1F5C42", brand: "#2F7D5B", ink: "#1E2A24", mute: "#6B7A72", chip: "#E3EBE4", line: "#D9DFD6" };
const num = (n: number) => ({ type: "box", layout: "vertical", width: "30px", height: "30px", cornerRadius: "15px", backgroundColor: C.chip,
  justifyContent: "center", alignItems: "center", flex: 0, contents: [T(String(n).padStart(2, "0"), { size: "xs", weight: "bold", color: C.deep, wrap: false })] });
const dots = (active: number, total: number) => ({ type: "box", layout: "horizontal", spacing: "sm", justifyContent: "center", contents: Array.from({ length: total }, (_, i) => (
  { type: "box", layout: "vertical", width: "8px", height: "8px", cornerRadius: "4px", backgroundColor: i === active ? C.deep : "#D3D6D1", contents: [{ type: "filler" }] })) });
const cardV2 = (i: number, total: number, eyebrow: string, title: string, sub: string, body: unknown[], button?: { label: string; uri: string }, hint?: string) => ({
  type: "bubble", size: "mega",
  styles: { body: { backgroundColor: C.bg }, footer: { backgroundColor: C.bg } },
  hero: { type: "image", url: CARD_HEADER, size: "full", aspectRatio: "1040:225", aspectMode: "cover" },
  body: { type: "box", layout: "vertical", spacing: "md", paddingTop: "4px", paddingAll: "20px", contents: [
    T(`${String(i + 1).padStart(2, "0")} / ${eyebrow}`, { size: "xs", weight: "bold", color: C.deep }),
    T(title, { size: "xl", weight: "bold", color: C.deep }),
    T(sub, { size: "sm", color: C.mute }),
    ...body,
  ] },
  footer: { type: "box", layout: "vertical", spacing: "md", paddingTop: "0px", paddingAll: "16px", contents: [
    ...(button ? [{ type: "button", style: "secondary", height: "md", action: { type: "uri", label: button.label, uri: button.uri } }] : []),
    ...(hint ? [T(hint, { size: "xs", color: C.mute, align: "center" })] : []),
    dots(i, total),
  ] },
});

// 問卷答完（A 組）：封面、你的回答、為什麼這樣整理、下一步；不含品項。nick 是客人自己設定的稱呼，沒有就不叫名字。
function reportFlexV2(r: Report, nick?: string) {
  const pills = [
    `最想照顧：${r.focus.map(f => f.label).join("、") || "還沒選"}`,
    `目前固定補充：${r.taking.join("、") || "沒有"}`,
    ...(r.diet ? [`飲食習慣：${r.diet}`] : []),
    `希望每天：${r.tier} 項`,
  ];
  const pill = (t: string, n: number) => ({ type: "box", layout: "horizontal", spacing: "md", alignItems: "center", paddingAll: "8px",
    cornerRadius: "20px", borderWidth: "1px", borderColor: C.line, contents: [num(n), T(t, { size: "sm", color: C.deep, weight: "bold" })] });
  const why = [
    ["目前固定補充的品項", "避免和既有習慣重複。"], ["想優先照顧的日常狀態", "先整理你最在意的方向。"],
    ["飲食習慣與生活作息", "作為後續整理的參考。"], ["安全與重複補充確認", "讓建議更一致。"],
  ];
  const whyRow = (t: [string, string], n: number) => ({ type: "box", layout: "vertical", spacing: "sm", contents: [
    { type: "box", layout: "horizontal", spacing: "md", alignItems: "center", contents: [num(n), { type: "box", layout: "vertical", contents: [T(t[0], { size: "sm", weight: "bold", color: C.deep }), T(t[1], { size: "xs", color: C.mute })] }] },
    ...(n < 4 ? [{ type: "separator", color: C.line, margin: "sm" }] : []),
  ] });
  const steps = ["整理你的問卷回答", "確認目前固定補充的內容", "完成後通知你查看本月組合"];
  const step = (t: string, n: number) => ({ type: "box", layout: "horizontal", spacing: "md", alignItems: "center", contents: [num(n), T(t, { size: "sm", color: C.ink })] });
  const total = 4;
  return { type: "flex", altText: "你的 Deerly 專屬報告", contents: { type: "carousel", contents: [
    cardV2(0, total, "PERSONAL EDITION", nick ? `Hi，${nick}。` : "你好。", "你的專屬營養補充品提案，依照你的問卷回答整理。", [], undefined, "向左滑動查看 ›"),
    cardV2(1, total, "YOUR RESPONSES", "這次，我們先從你的問卷回答開始", "以下內容會作為後續整理的參考", pills.map((t, i) => pill(t, i + 1)), undefined, "繼續向左滑 ›"),
    cardV2(2, total, "MADE FOR YOU", "為什麼會先整理成這樣的方向？", "我們會依照你的問卷回答逐項查看", why.map((t, i) => whyRow(t as [string, string], i + 1)), undefined, "再向左滑一張 ›"),
    cardV2(3, total, "NEXT STEP", "接下來，Deerly 會怎麼做？", "我們會先整理你的問卷回答，再通知你查看後續內容", steps.map((t, i) => step(t, i + 1)), { label: "前往我的 Deerly", uri: `${LIFF_URL}/me/` }),
  ] } };
}

// 核准後：本月組合（每項一張，附原因）
function packFlex(tier: number, items: { name: string; dailyCapsules: number | null; reason: string }[]) {
  const head = bubble("本月組合", [
    T(`每天 ${tier} 項，一包整理好。`, { size: "lg", weight: "bold", color: "#1F5C42" }),
    T("每項都附上為什麼放進來，向左滑看。每個月我們會依你的回答調整一次，並寫下調整的原因。", { size: "md", color: "#7A8780" }),
  ]);
  const cards = items.map((it, i) => bubble(`${i + 1}　${it.name}`, [
    ...(it.dailyCapsules ? [T(`每天 ${it.dailyCapsules} 顆`, { size: "md", color: "#1E2A24" })] : []),
    T(it.reason || "依你的回答放入", { size: "md", color: "#7A8780" }),
  ]));
  const last = bubble("下一步", [
    T("看完整的組合、過去的報告和量測紀錄。", { size: "md", color: "#1E2A24" }),
  ], { type: "box", layout: "vertical", paddingAll: "16px", contents: [
    { type: "button", style: "primary", color: "#2F7D5B", height: "md", action: { type: "uri", label: "打開我的 Deerly", uri: `${LIFF_URL}/me/` } },
  ] });
  return { type: "flex", altText: "你的 Deerly 本月組合", contents: { type: "carousel", contents: [head, ...cards, last] } };
}

// 管理者預覽用的固定測試資料：真的跑一次規則引擎，確保卡片內容和正式一致
const PREVIEW_ANSWERS = {
  age: "30_34", sex: "female", pregnancy: "no", medication: "no", conditions: ["none"], allergy: ["none"], diet: "omni",
  supplements: ["b"], spend: "500_1000", focus: ["sleep", "stress"], sleep_hours: "lt6", sleep_quality: "poor", stress: "high",
  caffeine: "3plus", alcohol: "1_2", meals_out: "most", veg: "0_1", bowel: "regular", exercise: "0", tier: "basic",
};
function previewCards(kind: "report" | "pack") {
  const result = buildPack(PREVIEW_ANSWERS, DATA);
  const note = { type: "text", text: "（預覽：固定測試資料，只有管理者看得到）" };
  if (kind === "report") return [note, reportFlexV2(buildReport(result, PREVIEW_ANSWERS, DATA))];
  return [note, packFlex(result.tier, result.items)];
}

// 套用一個答案後往下走
async function advance(sub: string, replyToken: string, s: Session, q: Q, notice?: string) {
  const rejectOpt = q.options.find((o) => o.reject && [].concat(s.answers[q.id] as never).includes(o.value as never));
  if (rejectOpt) {
    await clearSession(s.user_id);
    await line(`/v2/bot/user/${sub}/richmenu`, "DELETE").catch(() => {});
    return reply(replyToken, [{ type: "text", text: DATA.claims.rejectMessages[rejectOpt.reject!] }, {
      type: "text", text: "如果是選錯了，輸入「開始問卷」可以重新來。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]),
    }]);
  }
  s.history.push(q.id);
  const nq = nextQuestion(s.answers, q.id);
  if (!nq) return finish(sub, replyToken, s);
  s.cur = nq.id;
  s.multi = [];
  await saveSession(s);
  return askQuestion(sub, replyToken, s, notice);
}

const startQuick = quick([{ label: "開始問卷", text: "開始問卷" }]);
const reportQuick = quick([{ label: "看專屬報告", text: "我的報告" }]);

// 主選單「我的組合」：看最近一份的狀態
async function showPack(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const p = uid
    ? await db.from("packs").select("status,item_ids,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : null;
  if (p?.error) throw p.error;
  if (!p?.data) return reply(replyToken, [{ type: "text", text: "你還沒有組合。回答 20 題問卷，我們就能整理一份給你。", quickReply: startQuick }]);
  if (p.data.status === "approved") {
    const names = (p.data.item_ids as string[]).map((id) => DATA.items.items.find((i: { id: string }) => i.id === id)?.name ?? id);
    return reply(replyToken, [{ type: "text", text: `你目前的每日組合：\n${names.map((n) => `・${n}`).join("\n")}\n\n每月會依你的狀況調整一次。`, quickReply: reportQuick }]);
  }
  if (p.data.status === "returned") return reply(replyToken, [{ type: "text", text: "上一份組合需要再調整，請重新回答問卷。", quickReply: startQuick }]);
  return reply(replyToken, [{ type: "text", text: "你的組合整理中，確認後會在這裡通知你。", quickReply: reportQuick }]);
}

// 重看最近一份問卷的專屬報告
async function showReport(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const p = uid
    ? await db.from("packs").select("result,intakes(answers)").eq("user_id", uid).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : null;
  if (p?.error) throw p.error;
  const answers = (p?.data as { intakes?: { answers?: Record<string, unknown> } } | null)?.intakes?.answers;
  if (!p?.data || !answers) return reply(replyToken, [{ type: "text", text: "你還沒有報告。回答 20 題問卷，我們就能整理一份給你。", quickReply: startQuick }]);
  return reply(replyToken, [reportFlexV2(buildReport(p.data.result, answers, DATA))]);
}

// 掃臉完成後，使用者端會自動送出「我量好了」，這裡回覆最新一次的結果
async function onScanDone(sub: string, replyToken: string) {
  const uid = await findUser(sub, false);
  const rows = uid
    ? await db.from("scans").select("bpm,quality,scanned_at").eq("user_id", uid).order("scanned_at", { ascending: false }).limit(60)
    : null;
  if (rows?.error) throw rows.error;
  const last = rows?.data?.[0];
  const again = quick([{ label: "再量一次", uri: LIFF_URL }]);
  if (!last || Date.now() - new Date(last.scanned_at).getTime() > 15 * 60e3) {
    return reply(replyToken, [{ type: "text", text: "還沒看到新的量測結果，請點下方選單的「今日電量」。", quickReply: again }]);
  }
  if (last.quality < 0.35) return reply(replyToken, [{ type: "text", text: "這次訊號不太穩，請在光線充足的地方再量一次。", quickReply: again }]);
  const base = (rows!.data as { bpm: number; quality: number; scanned_at: string }[]).slice(1)
    .filter((r) => r.quality >= 0.55 && Date.now() - new Date(r.scanned_at).getTime() < 28 * 864e5).map((r) => r.bpm).sort((a, b) => a - b);
  let cmp = "";
  if (base.length >= 3) {
    const m = base.length >> 1, med = base.length % 2 ? base[m] : (base[m - 1] + base[m]) / 2;
    const d = Math.round(last.bpm - med);
    cmp = d === 0 ? "，和你平常差不多" : `，比你平常${d > 0 ? "高" : "低"} ${Math.abs(d)} 下`;
  }
  const hasPack = uid ? !!(await db.from("packs").select("id").eq("user_id", uid).limit(1)).data?.length : false;
  const next = hasPack ? "" : "\n\n心率只是讓你認識自己，組合由問卷回答決定。接著回答問卷，整理你的每日組合。";
  return reply(replyToken, [{
    type: "text", text: `你剛剛量到每分鐘 ${Math.round(last.bpm)} 下${cmp}。心率僅供參考，不影響配方。${next}`,
    ...(hasPack ? {} : { quickReply: startQuick }),
  }]);
}

async function onPostback(sub: string, replyToken: string, data: string) {
  if (data.startsWith('rlx|')) return relaxGuard(sub, replyToken, () => relaxPostback(sub, replyToken, data));
  const [kind, qid, value] = data.split("|");
  if (kind === "home") return qid === "pack" ? showPack(sub, replyToken) : startFlow(sub, replyToken);
  if (kind === "restart") return startFlow(sub, replyToken, true);
  if (kind === "consent") {
    if (qid !== "yes") return reply(replyToken, [{ type: "text", text: "好的，需要的時候輸入「開始問卷」就可以。" }]);
    const uid = await findUser(sub, true);
    if (!uid) return;
    if (!(await hasConsent(uid))) {
      const r = await db.from("consents").insert({ user_id: uid, version: CONSENT_VERSION });
      if (r.error) throw r.error;
    }
    return startFlow(sub, replyToken);
  }
  const uid = await findUser(sub, false);
  const s = uid ? await loadSession(uid) : null;
  if (!uid || !s || !s.cur) return reply(replyToken, [{ type: "text", text: "輸入「開始問卷」就可以開始。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]) }]);

  if (kind === "resume") return askQuestion(sub, replyToken, s);

  if (kind === "back") {
    const prev = s.history.pop();
    if (!prev) return askQuestion(sub, replyToken, s);
    delete s.answers[prev];
    s.cur = prev;
    s.multi = [];
    await saveSession(s);
    return askQuestion(sub, replyToken, s);
  }

  const q = QS.find((x) => x.id === qid);
  // 點到舊的選單（不是目前這一題）就忽略，重送目前這一題
  if (!q || q.id !== s.cur) return askQuestion(sub, replyToken, s);

  if (kind === "a" && q.type === "single") {
    if (!q.options.some((o) => o.value === value)) return askQuestion(sub, replyToken, s);
    s.answers[q.id] = value;
    return advance(sub, replyToken, s, q);
  }
  if (kind === "m" && q.type === "multi") {
    const o = q.options.find((x) => x.value === value);
    if (!o) return askQuestion(sub, replyToken, s);
    const sel = new Set(s.multi);
    let notice: string | undefined;
    if (sel.has(o.value)) sel.delete(o.value);
    else if (o.exclusive) { sel.clear(); sel.add(o.value); }
    else {
      for (const x of q.options) if (x.exclusive) sel.delete(x.value);
      if (q.max && sel.size >= q.max) notice = `最多選 ${q.max} 項，要換的話請先點掉一項。`;
      else sel.add(o.value);
    }
    s.multi = q.options.map((x) => x.value).filter((v) => sel.has(v));
    await saveSession(s);
    const names = s.multi.map((v) => { const x = q.options.find((y) => y.value === v)!; return x.chip ?? x.label; });
    const now = names.length ? `目前選了：${names.join("、")}` : "目前還沒選";
    return reply(replyToken, [{ type: "text", text: `${notice ? notice + "\n" : ""}${now}\n（再點一次可取消，選好請按「完成」）` }]);
  }
  if (kind === "d" && q.type === "multi") {
    if (!s.multi.length) {
      // 什麼都沒選就按完成，視為「都沒有」；沒有這個選項的題目（如重點關注）才要求至少選一項
      const none = q.options.find((o) => o.exclusive);
      if (!none) return askQuestion(sub, replyToken, s, "請至少選一項。");
      s.answers[q.id] = [none.value];
      return advance(sub, replyToken, s, q, `沒有選的話，記為「${none.chip ?? none.label}」。`);
    }
    s.answers[q.id] = [...s.multi];
    return advance(sub, replyToken, s, q);
  }
  return askQuestion(sub, replyToken, s);
}

async function onText(sub: string, replyToken: string, text: string) {
  const t = text.trim();
  if(["繼續","繼續放鬆測試"].includes(t) && relaxMenuTestScope() && relaxAllowed(sub))return relaxGuard(sub,replyToken,async()=>{
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    if(!s)return relaxStart(sub,replyToken);
    return relaxAsk(sub,replyToken,s.paused?await relaxUpdate(s,{paused:false}):s);
  });
  if(t === "選單診斷")return relaxGuard(sub,replyToken,()=>relaxMenuDiagnose(sub,replyToken));
  if(t === "收起放鬆選單")return relaxGuard(sub,replyToken,async()=>{
    if(!relaxMenuTestScope())return reply(replyToken,[{type:"text",text:"這個操作只適用測試帳號。"}]);
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    if(s){await relaxMenusRestore(sub,s);if(!s.paused)await relaxUpdate(s,{paused:true});}
    return reply(replyToken,[{type:"text",text:"已收起選單，進度幫你留著。想繼續時傳任何訊息就可以。"}]);
  });
  if (["放鬆測試","放鬆練習","14天放鬆","14 天放鬆","重新開始放鬆測試"].includes(t)) return relaxGuard(sub,replyToken,()=>relaxStart(sub,replyToken));
  if (["刪除我的資料","刪除放鬆測試資料"].includes(t)) return relaxGuard(sub,replyToken,()=>relaxDelete(sub,replyToken));
  if (/^放鬆量測完成 /.test(t)) return relaxGuard(sub,replyToken,async()=>{
    if (!relaxAllowed(sub)) return reply(replyToken,[{type:"text",text:"放鬆測試目前未開放。"}]);
    const uid=await findUser(sub,false), s=uid?await relaxSession(uid):null;
    if (s && t === `放鬆量測完成 ${s.flow_id}`) return relaxScanDone(sub,replyToken,s);
    return reply(replyToken,[{type:"text",text:"這個量測連結已經過期了，傳任何訊息就能接著做。"}]);
  });
  if (t === "我量好了" && relaxAllowed(sub)) {
    const handled=await relaxGuard(sub,replyToken,async()=>{
      const uid=await findUser(sub,false), s=uid?await relaxSession(uid):null;
      if (s?.status === "scan" && !s.paused) { await relaxScanDone(sub,replyToken,s); return true; }
      return false;
    });
    if (handled !== false) return;
  }
  // The isolated test bot only runs the relaxation quiz: any other text re-shows where the tester is.
  if (relaxMenuTestScope() && relaxAllowed(sub)) return relaxGuard(sub,replyToken,async()=>{
    const uid=await findUser(sub,false),s=uid?await relaxSession(uid):null;
    return s?relaxAsk(sub,replyToken,s):relaxStart(sub,replyToken);
  });
  if (/^(開始問卷|開始|問卷)$/.test(text.trim())) return startFlow(sub, replyToken);
  if (/^我量好了/.test(text.trim())) return onScanDone(sub, replyToken);
  if (/^(我的報告|報告|看報告)$/.test(text.trim())) return showReport(sub, replyToken);
  if (text.trim() === "我的組合") return showPack(sub, replyToken);
  if (ADMINS.includes(sub) && /^預覽(報告|組合)$/.test(text.trim())) return reply(replyToken, previewCards(text.trim() === "預覽報告" ? "report" : "pack"));
  if (text.trim() === "上一題") return onPostback(sub, replyToken, "back");
  const uid = await findUser(sub, false);
  const s = uid ? await loadSession(uid) : null;
  if (s?.cur) return askQuestion(sub, replyToken, s, "請用下方的按鈕作答。");
  return reply(replyToken, [{ type: "text", text: "嗨，歡迎來到 Deerly。想整理你的每日組合，點下面開始。", quickReply: quick([{ label: "開始問卷", text: "開始問卷" }]) }]);
}

async function onEvent(ev: { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string }; postback?: { data: string } }) {
  const sub = ev.source?.userId;
  if (!sub || !ev.replyToken) return;
  if (ev.type === "follow") return onText(sub, ev.replyToken, "");
  if (ev.type === "message" && ev.message?.type === "text") return onText(sub, ev.replyToken, ev.message.text ?? "");
  if (ev.type === "postback" && ev.postback) return onPostback(sub, ev.replyToken, ev.postback.data);
}


// ---------- 自願參加的數位放鬆方案測試（與既有保健品流程隔離）----------
// @@PILOT@@
// @@RELAX_FLEX@@
// @@RELAX_MENU@@
const RELAX_PILOT_ENABLED = Deno.env.get("RELAX_PILOT_ENABLED") === "1";
const RELAX_PILOT_LINE_SUBS = (Deno.env.get("RELAX_PILOT_LINE_SUBS") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const relaxAllowed = (sub: string) => RELAX_PILOT_ENABLED && (ADMINS.includes(sub) || RELAX_PILOT_LINE_SUBS.includes(sub));
const RELAX_CONSENT_VERSION = "relax-pilot-2026-10";
type RelaxSession = {
  user_id: string; answers: Record<string, string>; step: number;
  status: "quiz" | "scan" | "preview"; scan_opt_in: boolean;
  scan_started_at?: string | null; flow_id: string; revision: number;
  current_rich_menu_id?: string | null; previous_rich_menu_id?: string | null; rich_menu_captured?: boolean;
  paused: boolean; interest_clicked_at?: string | null; created_at: string;
};
const relaxData = (s: RelaxSession) => (data: string) => `${data}~${s.flow_id}~${s.revision}`;
const relaxScanUrl = (s: RelaxSession) => `${LIFF_URL}/?relaxPilot=${encodeURIComponent(s.flow_id)}`;
async function relaxSession(uid: string): Promise<RelaxSession | null> {
  const q = await db.from("digital_relax_pilot_sessions").select("*").eq("user_id", uid).maybeSingle();
  if (q.error) throw q.error;
  if (q.data && Date.now() - Date.parse(q.data.created_at) >= 30 * 864e5) {
    const u=await db.from("users").select("line_sub").eq("id",uid).maybeSingle();
    if(u.error)throw u.error;
    if(u.data?.line_sub)await relaxMenusRestore(u.data.line_sub,q.data);
    const expired = await db.from("digital_relax_pilot_sessions").delete().eq("user_id", uid).eq("flow_id", q.data.flow_id);
    if (expired.error) throw expired.error;
    return null;
  }
  return q.data as RelaxSession | null;
}
// Optimistic concurrency: stale/replayed buttons cannot advance a new step or reset a new run.
async function relaxUpdate(s: RelaxSession, changes: Record<string, unknown>): Promise<RelaxSession> {
  const q = await db.from("digital_relax_pilot_sessions")
    .update({ ...changes, revision: s.revision + 1, updated_at: new Date().toISOString() })
    .eq("user_id", s.user_id).eq("flow_id", s.flow_id).eq("revision", s.revision).select("*").maybeSingle();
  if (q.error) throw q.error;
  if (!q.data) throw new Error("RELAX_STALE_ACTION");
  return q.data as RelaxSession;
}
async function relaxStart(sub: string, token: string) {
  if (!relaxAllowed(sub)) return reply(token, [{ type: "text", text: "這個放鬆服務目前只開放受邀測試；原本的 Deerly 服務不受影響。" }]);
  const uid = await findUser(sub, false);
  const existing = uid ? await relaxSession(uid) : null;
  if (existing) {
    const data = relaxData(existing);
    return reply(token, [{ type:"text", text:"你上次的放鬆練習還沒做完。要接著做，還是重新開始？",
      quickReply:quick([{label:"接著做",data:data("rlx|resume")},{label:"重新開始",data:data("rlx|restart")},{label:"刪除我的資料",data:data("rlx|delete")}]) }]);
  }
  return reply(token, [relaxWelcome()]);
}
async function relaxAsk(sub: string, token: string, s: RelaxSession) {
  const data = relaxData(s);
  if (s.paused) { await relaxMenusTryRestore(sub,s); return reply(token,[{type:"text",text:"先暫停囉，進度幫你留著。想繼續時傳任何訊息就可以。",quickReply:quick([{label:"繼續",data:data("rlx|resume")},{label:"刪除我的資料",data:data("rlx|delete")}])}]); }
  if (s.status === "preview") return relaxPreview(sub,token, s);
  if (s.status === "scan") return relaxOfferScan(sub,token, s);
  const q = catalog.relax.questions[s.step];
  if (!q) throw new Error("RELAX_INVALID_STEP");
  const items = q.options.map((o: {value:string;label:string})=>({label:o.label,data:data("rlx|answer|"+s.step+"|"+o.value)}));
  if (s.step > 0) items.push({label:"上一題",data:data("rlx|back")});
  items.push({label:"先暫停",data:data("rlx|pause")});
  let rich=false;
  let menuStatus=relaxMenuTestScope()?(Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED")==="1"?"MENU_STATE_CHANGED":"MENU_SWITCH_OFF"):"MENU_TEST_SCOPE_MISMATCH";
  try{rich=await relaxMenusShow(sub,s);}catch(e){menuStatus=relaxMenuFailure(e);console.error("Test menu fallback",menuStatus);}
  const prompt=`放鬆練習 ${s.step+1}/5\n${q.text}`;
  if(rich)return reply(token,[{type:"text",text:prompt+(s.step===0?"\n請點下方選單作答。":"")}]);
  return reply(token,[{type:"text",text:prompt+`\n請用訊息下方按鈕作答。大字選單狀態：${menuStatus}；可輸入「選單診斷」查詢。`,quickReply:quick(items)}]);
}
async function relaxOfferScan(sub: string, token: string, s: RelaxSession) {
  await relaxMenusTryRestore(sub,s);
  const message = relaxScanCard(relaxData(s), s.scan_opt_in ? relaxScanUrl(s) : undefined);
  message.quickReply = quick([{label:"我量好了",data:relaxData(s)("rlx|done")},{label:"先暫停",data:relaxData(s)("rlx|pause")}]);
  return reply(token,[message]);
}
async function relaxPreview(sub: string, token: string, s: RelaxSession, bpm?: number) {
  await relaxMenusTryRestore(sub,s);
  const preview = createPreview(catalog.relax,s.answers);
  return reply(token,[relaxResultCard(preview,bpm),relaxInterestCard(preview,relaxData(s))]);
}
async function relaxScanDone(sub: string, token: string, s: RelaxSession) {
  if (s.status !== "scan" || s.paused || !s.scan_opt_in || !s.scan_started_at) return relaxAsk(sub,token,s);
  const scans = await db.from("scans").select("bpm,quality,scanned_at").eq("user_id",s.user_id)
    .gte("scanned_at",s.scan_started_at).order("scanned_at",{ascending:false}).limit(1);
  if (scans.error) throw scans.error;
  const last = scans.data?.[0], now = Date.now();
  const time = Date.parse(last?.scanned_at ?? ""), started = Date.parse(s.scan_started_at);
  if (!last || !Number.isFinite(time) || !Number.isFinite(started) || time < started || time > now || now-time > 15*60e3 ||
      !Number.isFinite(last.quality) || last.quality < 0.35 || !Number.isFinite(last.bpm) || last.bpm < 30 || last.bpm > 220) {
    return reply(token,[{type:"text",text:"這次沒有量到清楚的心跳。沒關係，可以再量一次，或直接看計畫。",
      quickReply:quick([{label:"再量一次",uri:relaxScanUrl(s)},{label:"直接看計畫",data:relaxData(s)("rlx|scan|skip")}])}]);
  }
  const next = await relaxUpdate(s,{status:"preview"});
  return relaxPreview(sub,token,next,last.bpm);
}
async function relaxPostback(sub: string, token: string, raw: string) {
  if (!relaxAllowed(sub)) return reply(token,[{type:"text",text:"放鬆測試目前未開放。"}]);
  const [data,flow,revision] = raw.split("~");
  const [prefix,kind,detail,value] = data.split("|");
  if (prefix !== "rlx") return;
  if (kind === "privacy") return reply(token,relaxPrivacy.map(text=>({type:"text",text})));
  if (kind === "start" && detail === "no") return reply(token,[{type:"text",text:"好的，沒有保存任何資料。想試的時候，傳任何訊息給我就可以。"}]);
  if (kind === "start" && detail === "yes") {
    const uid = await findUser(sub,true);
    if (!uid) throw new Error("RELAX_USER_MISSING");
    const existing = await relaxSession(uid);
    if (existing) return relaxAsk(sub,token,existing); // repeated consent never resets progress
    const up = await db.from("digital_relax_pilot_sessions").upsert({
      user_id:uid,consent_version:RELAX_CONSENT_VERSION,created_at:new Date().toISOString(),
      flow_id:crypto.randomUUID(),revision:0,paused:false,answers:{},step:0,status:"quiz",scan_opt_in:false,
      scan_started_at:null,interest_clicked_at:null,updated_at:new Date().toISOString()
    },{onConflict:"user_id",ignoreDuplicates:true});
    if (up.error) throw up.error;
    const s = await relaxSession(uid);
    if (!s) throw new Error("RELAX_SESSION_MISSING");
    return relaxAsk(sub,token,s);
  }
  const uid = await findUser(sub,false), s = uid ? await relaxSession(uid) : null;
  if (!s) return relaxStart(sub,token);
  // Shared menu taps carry the question number instead of flow/revision; only the current question counts.
  const current = flow === "menu"
    ? s.status === "quiz" && ["answer","back","pause"].includes(kind) && detail === String(s.step)
    : flow === s.flow_id && revision === String(s.revision);
  if (!current) return relaxAsk(sub,token,s);
  if (kind === "delete") return relaxDelete(sub,token,s);
  if (kind === "restart") {
    // Explicit, scoped reset, followed by a fresh consent screen; duplicate old buttons cannot reset again.
    await relaxDelete(sub,token,s,false);
    return reply(token,[relaxWelcome()]);
  }
  if (kind === "resume") return relaxAsk(sub,token,s.paused?await relaxUpdate(s,{paused:false}):s);
  if (kind === "pause") return relaxAsk(sub,token,await relaxUpdate(s,{paused:true}));
  if (s.paused) return relaxAsk(sub,token,s);
  if (kind === "back" && s.status === "quiz" && s.step>0) {
    const step=s.step-1;
    const answers=Object.fromEntries(catalog.relax.questions.slice(0,step).map(q=>[q.id,s.answers[q.id]]));
    return relaxAsk(sub,token,await relaxUpdate(s,{step,answers}));
  }
  if (kind === "answer" && s.status === "quiz") {
    const q=catalog.relax.questions[s.step];
    if (detail !== String(s.step) || !q || !q.options.some(o=>o.value===value)) return relaxAsk(sub,token,s);
    const step=s.step+1;
    return relaxAsk(sub,token,await relaxUpdate(s,{answers:{...s.answers,[q.id]:value},step,status:step===5?"scan":"quiz"}));
  }
  if (kind === "scan" && s.status === "scan") {
    if (detail === "skip") return relaxPreview(sub,token,await relaxUpdate(s,{status:"preview",scan_opt_in:false,scan_started_at:null}));
    if (detail === "yes") return relaxOfferScan(sub,token,s.scan_opt_in?s:await relaxUpdate(s,{scan_opt_in:true,scan_started_at:new Date().toISOString()}));
  }
  if (kind === "done") return relaxScanDone(sub,token,s);
  if (kind === "interest" && s.status === "preview") {
    if (!s.interest_clicked_at) await relaxUpdate(s,{interest_clicked_at:new Date().toISOString()});
    return reply(token,[{type:"text",text:"謝謝，已幫你登記！目前不會收費，也沒有成立訂單。"}]);
  }
  return relaxAsk(sub,token,s);
}
async function relaxDelete(sub: string, token: string, session?: RelaxSession, respond = true) {
  if (!relaxAllowed(sub)) return reply(token,[{type:"text",text:"放鬆測試目前未開放。"}]);
  const uid = session?.user_id ?? await findUser(sub,false);
  if (uid) {
    const existing=session??await relaxSession(uid);
    if(existing)await relaxMenusRestore(sub,existing);
    let query = db.from("digital_relax_pilot_sessions").delete().eq("user_id",uid);
    if (session) query=query.eq("flow_id",session.flow_id).eq("revision",session.revision);
    const r=await query.select("user_id");
    if (r.error) throw r.error;
    if (session && !r.data?.length) throw new Error("RELAX_STALE_ACTION");
  }
  if (respond) return reply(token,[{type:"text",text:"已刪除你的放鬆練習回答與紀錄。心率紀錄請到量測頁刪除。"}]);
}
// In-instance ordering + DB revision comparisons protect rapid clicks across instances.
const relaxQueues = new Map<string, Promise<unknown>>();
async function relaxGuard(sub: string, token: string, work: () => Promise<unknown>) {
  const previous=relaxQueues.get(sub) ?? Promise.resolve();
  const current=previous.catch(()=>{}).then(work).catch(async e=>{
    // Do not log answer values, LINE IDs or raw DB errors.
    console.error("Relax pilot operation failed");
    const text=e instanceof Error && e.message==="RELAX_STALE_ACTION"
      ?"進度剛剛更新過，傳任何訊息就能接著做。"
      :"剛才沒有完成，傳任何訊息就能接著做；也可以輸入「刪除我的資料」。";
    return reply(token,[{type:"text",text}]);
  });
  relaxQueues.set(sub,current);
  try { return await current; } finally { if (relaxQueues.get(sub)===current) relaxQueues.delete(sub); }
}

// ---------- 管理：建立選單 ----------
async function setupMenus() {
  const areasRes = await fetch(`${ASSET_BASE}areas.json`);
  if (!areasRes.ok) throw new Error(`areas.json ${areasRes.status}`);
  const { version, areas } = await areasRes.json();
  if (version !== DATA.questions.version) throw new Error(`選單圖版本 ${version} 與題目版本 ${DATA.questions.version} 不一致，請先更新選單圖`);
  const old = await db.from("rich_menus").select("question_id,rich_menu_id");
  if (old.error) throw old.error;
  const done: string[] = [];
  for (const q of QS) {
    const a = areas[q.id];
    if (!a) throw new Error(`缺少 ${q.id} 的選單圖`);
    const created = await line("/v2/bot/richmenu", "POST", {
      size: { width: 2500, height: 1686 }, selected: true, name: `q-${q.id}`, chatBarText: "點這裡作答",
      areas: a.map((x: { x: number; y: number; w: number; h: number; value: string }) => ({
        bounds: { x: x.x, y: x.y, width: x.w, height: x.h },
        action: x.value === "__done"
          ? { type: "postback", data: `d|${q.id}`, displayText: "完成 ✔" }
          : { type: "postback", data: `${q.type === "multi" ? "m" : "a"}|${q.id}|${x.value}`, displayText: (q.options.find((o) => o.value === x.value)?.chip ?? q.options.find((o) => o.value === x.value)?.label ?? "").slice(0, 300) },
      })),
    });
    const img = await fetch(`${ASSET_BASE}${q.id}.png`);
    if (!img.ok) throw new Error(`${q.id}.png ${img.status}`);
    const up = await fetch("https://api-data.line.me/v2/bot/richmenu/" + created.richMenuId + "/content", {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" }, body: new Uint8Array(await img.arrayBuffer()),
    });
    if (!up.ok) throw new Error(`上傳 ${q.id} 失敗 ${up.status}`);
    const prev = (old.data ?? []).find((x: { question_id: string }) => x.question_id === q.id);
    const u = await db.from("rich_menus").upsert({ question_id: q.id, rich_menu_id: created.richMenuId, questions_version: DATA.questions.version });
    if (u.error) throw u.error;
    if (prev) await line(`/v2/bot/richmenu/${prev.rich_menu_id}`, "DELETE").catch(() => {});
    done.push(q.id);
  }
  done.push(await setupHome(areas.home));
  return done;
}

// 主選單（預設選單）：今日電量、每日問卷、我的 Deerly（開 LIFF 頁）。沒有在作答的人都看這個
async function setupHome(a: { key: string; x: number; y: number; w: number; h: number }[]) {
  if (!a) throw new Error("缺少主選單的圖");
  const act = (k: string) => k === "scan"
    ? { type: "uri", uri: LIFF_URL }
    : k === "me"
    ? { type: "uri", uri: `${LIFF_URL}/me/` }
    : { type: "postback", data: `home|${k}`, displayText: "開始問卷" };
  const created = await line("/v2/bot/richmenu", "POST", {
    size: { width: 2500, height: 1120 }, selected: false, name: "home", chatBarText: "主選單",
    areas: a.map((x) => ({ bounds: { x: x.x, y: x.y, width: x.w, height: x.h }, action: act(x.key) })),
  });
  const img = await fetch(`${ASSET_BASE}home.png`);
  if (!img.ok) throw new Error(`home.png ${img.status}`);
  const up = await fetch("https://api-data.line.me/v2/bot/richmenu/" + created.richMenuId + "/content", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" }, body: new Uint8Array(await img.arrayBuffer()),
  });
  if (!up.ok) throw new Error(`上傳 home 失敗 ${up.status}`);
  await line(`/v2/bot/user/all/richmenu/${created.richMenuId}`);
  const prev = await db.from("rich_menus").select("rich_menu_id").eq("question_id", "_home").maybeSingle();
  const u = await db.from("rich_menus").upsert({ question_id: "_home", rich_menu_id: created.richMenuId, questions_version: DATA.questions.version });
  if (u.error) throw u.error;
  if (prev.data) await line(`/v2/bot/richmenu/${prev.data.rich_menu_id}`, "DELETE").catch(() => {});
  return "home";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") return json({ ok: true, build: RELAX_MENU_BUILD, richMenuTestScope: relaxMenuTestScope(), richMenuSwitchOn: Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED") === "1" });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const raw = await req.text();

  // 管理動作：審核者帶 LINE ID token
  const sig = req.headers.get("x-line-signature");
  if (!sig) {
    let b: Record<string, unknown>;
    try { b = JSON.parse(raw); } catch { return json({ error: "json" }, 400); }
    const sub = typeof b.idToken === "string" ? await verifyIdToken(b.idToken) : null;
    if (!sub || !ADMINS.includes(sub)) return json({ error: "forbidden" }, 403);
    try {
      if (b.action === "setup") return json({ ok: true, menus: await setupMenus() });
      return json({ error: "action" }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: "server", detail: (e instanceof Error ? e.message : JSON.stringify(e)).slice(0, 300) }, 500);
    }
  }

  // LINE 伺服器的事件
  if (!(await verifySignature(raw, sig))) return json({ error: "signature" }, 401);
  let body: { events?: unknown[] };
  try { body = JSON.parse(raw); } catch { return json({ error: "json" }, 400); }
  for (const ev of body.events ?? []) {
    try { await onEvent(ev as never); } catch (e) { console.error(e); }
  }
  return json({ ok: true });
});
