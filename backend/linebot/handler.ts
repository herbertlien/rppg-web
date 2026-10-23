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

async function startFlow(sub: string, replyToken: string) {
  const uid = await findUser(sub, true);
  if (!uid) return;
  if (!(await hasConsent(uid))) {
    return reply(replyToken, [{
      type: "text", text: CONSENT_TEXT,
      quickReply: quick([{ label: "我同意，開始", data: "consent|yes" }, { label: "先不要", data: "consent|no" }]),
    }]);
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
  return reply(replyToken, [{ type: "text", text: "謝謝你！我們會依你的回答整理一包，確認後在這裡通知你。" }]);
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
    return reply(replyToken, [{ type: "text", text: `你目前的每日組合：\n${names.map((n) => `・${n}`).join("\n")}\n\n每月會依你的狀況調整一次。` }]);
  }
  if (p.data.status === "returned") return reply(replyToken, [{ type: "text", text: "上一份組合需要再調整，請重新回答問卷。", quickReply: startQuick }]);
  return reply(replyToken, [{ type: "text", text: "你的組合整理中，確認後會在這裡通知你。" }]);
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
    .filter((r) => r.quality >= 0.35 && Date.now() - new Date(r.scanned_at).getTime() < 28 * 864e5).map((r) => r.bpm).sort((a, b) => a - b);
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
  const [kind, qid, value] = data.split("|");
  if (kind === "home") return qid === "pack" ? showPack(sub, replyToken) : startFlow(sub, replyToken);
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
  if (/^(開始問卷|開始|問卷)$/.test(text.trim())) return startFlow(sub, replyToken);
  if (/^我量好了/.test(text.trim())) return onScanDone(sub, replyToken);
  if (text.trim() === "我的組合") return showPack(sub, replyToken);
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

// 主選單（預設選單）：今日電量、每日問卷、我的組合。沒有在作答的人都看這個
async function setupHome(a: { key: string; x: number; y: number; w: number; h: number }[]) {
  if (!a) throw new Error("缺少主選單的圖");
  const act = (k: string) => k === "scan"
    ? { type: "uri", uri: LIFF_URL }
    : { type: "postback", data: `home|${k}`, displayText: k === "quiz" ? "開始問卷" : "我的組合" };
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
  if (req.method === "GET") return json({ ok: true });
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
