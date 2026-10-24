// Supabase Edge Function：intake（原始碼）
// 不要直接貼這個檔。執行 `node backend/intake/build.mjs` 會把規則引擎與資料檔併進來，產生 index.ts，貼那個。
// 前端送 LINE ID token，這裡向 LINE 驗證身分後才讀寫資料庫；配方一律在這裡重算，不相信前端算的結果。
import { createClient } from "npm:@supabase/supabase-js@2";

// @@ENGINE@@

// @@DATA@@

const LINE_CHANNEL_ID = "2012160129";
const ALLOWED_ORIGIN = "https://herbertlien.github.io";
const CONSENT_VERSION = "intake-v1";
// 審核者的 LINE 使用者 ID，多個用逗號分隔。在 Supabase 的 Edge Function Secrets 設定 ADMIN_LINE_SUBS。
const ADMINS = (Deno.env.get("ADMIN_LINE_SUBS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

async function verifyLine(idToken: string): Promise<string | null> {
  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.sub === "string" ? j.sub : null;
}

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

const itemById = (id: string) => DATA.items.items.find((i: { id: string }) => i.id === id);

// 核准前用目前的資料重新判斷能不能出貨，不看當初存下的結果
// 測試模式：Supabase 函式秘密 TEST_APPROVE=1 時，略過「南都確認」與「藥師核定」兩項（劑量或禁忌錯誤仍會擋）。上線給真實客人前必須刪掉這個秘密
const TEST_APPROVE = Deno.env.get("TEST_APPROVE") === "1";
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LIFF_ME = "https://liff.line.me/2012160129-CwL40nTW/me/";

// 通知客人審核結果（每位客人 1 則，用推播額度）。失敗只記錄，不影響審核結果。
async function notifyDecision(userId: string, decision: "approved" | "returned") {
  try {
    if (!LINE_TOKEN) return;
    const u = await db.from("users").select("line_sub").eq("id", userId).maybeSingle();
    if (u.error || !u.data?.line_sub) return;
    const text = decision === "approved"
      ? `你的 Deerly 組合確認好了。這個月的品項和原因，點這裡看：\n${LIFF_ME}`
      : "你的組合還需要再調整，我們確認後會再通知你。";
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { authorization: `Bearer ${LINE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ to: u.data.line_sub, messages: [{ type: "text", text }] }),
    });
    if (!r.ok) console.error("push failed", r.status, await r.text());
  } catch (e) {
    console.error("push error", e);
  }
}

function approveBlockers(itemIds: string[]): string[] {
  const out: string[] = [];
  const check = checkPack(itemIds, DATA);
  out.push(...check.errors);
  if (TEST_APPROVE) return out;
  const pending = itemIds.map(itemById).filter((i) => i && i.status !== "confirmed").map((i) => i.name);
  if (pending.length) out.push(`尚未由南都確認：${pending.join("、")}`);
  if (!DATA.items.pharmacistApproved) out.push("品項資料尚未經藥師核定");
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply({ error: "json" }, 400); }

  const sub = typeof b.idToken === "string" ? await verifyLine(b.idToken) : null;
  if (!sub) return reply({ error: "auth" }, 401);
  const admin = ADMINS.includes(sub);

  try {
    if (b.action === "whoami") return reply({ sub, admin });

    // ---- 審核者 ----
    if (b.action === "review_list") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const r = await db.from("packs")
        .select("id,user_id,created_at,status,item_ids,result,review_note,intakes(answers,questions_version)")
        .eq("status", "needs_review").order("created_at", { ascending: true }).limit(50);
      if (r.error) throw r.error;
      // 附上客人近 28 天的心率摘要（只有量測數字，沒有影像）
      const since = new Date(Date.now() - 28 * 864e5).toISOString();
      const packs = [];
      for (const p of r.data) {
        const sc = await db.from("scans").select("scanned_at,bpm,quality")
          .eq("user_id", p.user_id).gte("scanned_at", since).gte("quality", 0.35).order("scanned_at", { ascending: false }).limit(100);
        if (sc.error) throw sc.error;
        const bpms = (sc.data ?? []).map((x: { bpm: number }) => Number(x.bpm)).sort((a: number, b: number) => a - b);
        const m = bpms.length >> 1;
        const { user_id: _u, ...rest } = p;
        packs.push({
          ...rest,
          scanSummary: bpms.length ? {
            n: bpms.length,
            median: Math.round(bpms.length % 2 ? bpms[m] : (bpms[m - 1] + bpms[m]) / 2),
            lastBpm: Math.round(Number(sc.data![0].bpm)),
            lastAt: sc.data![0].scanned_at,
          } : null,
        });
      }
      return reply({ packs, items: DATA.items.items.map((i: { id: string; name: string; enabled: boolean }) => ({ id: i.id, name: i.name, enabled: i.enabled })) });
    }

    if (b.action === "review_check") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const ids = Array.isArray(b.itemIds) ? b.itemIds.map(String) : [];
      return reply({ ...checkPack(ids, DATA), blockers: approveBlockers(ids), testMode: TEST_APPROVE });
    }

    if (b.action === "review_decide") {
      if (!admin) return reply({ error: "forbidden" }, 403);
      const packId = Number(b.packId);
      const decision = b.decision === "approve" ? "approved" : b.decision === "return" ? "returned" : null;
      if (!Number.isInteger(packId) || !decision) return reply({ error: "input" }, 400);
      const cur = await db.from("packs").select("status,item_ids,user_id").eq("id", packId).maybeSingle();
      if (cur.error) throw cur.error;
      if (!cur.data) return reply({ error: "not_found" }, 404);
      if (cur.data.status !== "needs_review") return reply({ error: "already_decided" }, 409);
      const ids = Array.isArray(b.itemIds) ? b.itemIds.map(String) : cur.data.item_ids;
      if (decision === "approved") {
        const blockers = approveBlockers(ids);
        if (blockers.length) return reply({ error: "blocked", blockers }, 409);
      }
      const up = await db.from("packs").update({
        status: decision,
        item_ids: ids,
        reviewed_at: new Date().toISOString(),
        review_note: ((String(b.note ?? "") + (decision === "approved" && TEST_APPROVE ? " [測試模式核准]" : "")).trim().slice(0, 500)) || null,
      }).eq("id", packId).eq("status", "needs_review");
      if (up.error) throw up.error;
      await notifyDecision(cur.data.user_id, decision);
      return reply({ ok: true });
    }

    // ---- 客人 ----
    const uid = await findUser(sub, b.action === "consent");
    if (!uid) {
      if (b.action === "mine") return reply({ consented: false, pack: null });
      if (b.action === "me") return reply({ consented: false, packs: [], scans: [] });
      if (b.action === "delete") return reply({ ok: true });
      return reply({ error: "consent" }, 403);
    }

    if (b.action === "consent") {
      if (!(await hasConsent(uid))) {
        const r = await db.from("consents").insert({ user_id: uid, version: CONSENT_VERSION });
        if (r.error) throw r.error;
      }
      return reply({ ok: true });
    }

    if (b.action === "mine") {
      const consented = await hasConsent(uid);
      const r = await db.from("packs").select("status,created_at,item_ids,result")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(1);
      if (r.error) throw r.error;
      const p = r.data?.[0];
      if (!p) return reply({ consented, pack: null });
      // 核准前只告訴客人「整理中」，不顯示引擎草稿
      const items = p.status === "approved"
        ? p.item_ids.map((id: string) => {
          const it = itemById(id);
          const fromEngine = (p.result.items ?? []).find((x: { id: string }) => x.id === id);
          return { name: it?.name ?? id, dailyCapsules: it?.dailyCapsules ?? null, reason: fromEngine?.reason ?? "" };
        })
        : null;
      return reply({ consented, pack: { status: p.status, createdAt: p.created_at, items } });
    }

    // 「我的 Deerly」頁：過去的報告、組合（核准後才有成分）、量測紀錄
    if (b.action === "me") {
      const consented = await hasConsent(uid);
      const pr = await db.from("packs").select("id,status,created_at,item_ids,result,intakes(answers)")
        .eq("user_id", uid).order("created_at", { ascending: false }).limit(12);
      if (pr.error) throw pr.error;
      // deno-lint-ignore no-explicit-any
      const rows: any[] = pr.data ?? [];
      const names = (p: { item_ids: string[] }) => p.item_ids.map((id) => itemById(id)?.name ?? id);
      const packs = rows.map((p, i) => {
        const approved = p.status === "approved";
        // 與前一份「已核准」組合比較，列出這個月加了什麼、拿掉什麼
        const prev = approved ? rows.slice(i + 1).find((x) => x.status === "approved") : null;
        const now = names(p), before = prev ? names(prev) : null;
        return {
          id: p.id, status: p.status, createdAt: p.created_at,
          report: p.intakes?.answers ? buildReport(p.result, p.intakes.answers, DATA) : null,
          items: approved
            ? p.item_ids.map((id: string) => {
              const it = itemById(id);
              return { name: it?.name ?? id, dailyCapsules: it?.dailyCapsules ?? null, reason: (p.result.items ?? []).find((x: { id: string }) => x.id === id)?.reason ?? "" };
            })
            : null,
          change: before ? { added: now.filter((n) => !before.includes(n)), removed: before.filter((n) => !now.includes(n)) } : null,
        };
      });
      const sc = await db.from("scans").select("scanned_at,bpm,quality,watch_bpm")
        .eq("user_id", uid).order("scanned_at", { ascending: false }).limit(60);
      if (sc.error) throw sc.error;
      return reply({ consented, packs, scans: sc.data });
    }

    if (b.action === "delete") {
      // 刪除使用者會連同掃描、同意、問卷、配方一起刪除
      const r = await db.from("users").delete().eq("id", uid);
      if (r.error) throw r.error;
      return reply({ ok: true });
    }

    if (b.action === "submit") {
      if (!(await hasConsent(uid))) return reply({ error: "consent" }, 403);
      const answers = b.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) return reply({ error: "input" }, 400);
      if (JSON.stringify(answers).length > 4000) return reply({ error: "input" }, 400);

      const last = await db.from("intakes").select("created_at").eq("user_id", uid)
        .order("created_at", { ascending: false }).limit(1);
      if (last.error) throw last.error;
      if (last.data?.length && Date.now() - new Date(last.data[0].created_at).getTime() < 30_000) {
        return reply({ error: "too_fast" }, 429);
      }

      // 網頁和後端的題目版本不同（例如網頁還是快取的舊版）時，請客人重開，避免用錯題目算配方
      if (b.questionsVersion !== DATA.questions.version) {
        return reply({ error: "outdated", expected: DATA.questions.version }, 409);
      }

      const result = buildPack(answers, DATA);
      if (result.status === "invalid") return reply({ error: "invalid", errors: result.errors }, 400);
      // 不接單的情況不保存答案（含懷孕、用藥等敏感資料），只回覆說明
      if (result.status === "rejected") return reply({ status: "rejected", messages: result.messages });

      // 只保存題目裡有的欄位
      const clean = Object.fromEntries(DATA.questions.questions.map((q: { id: string }) => [q.id, (answers as Record<string, unknown>)[q.id]]));
      const it = await db.from("intakes").insert({ user_id: uid, questions_version: DATA.questions.version, answers: clean })
        .select("id").single();
      if (it.error) throw it.error;
      const pk = await db.from("packs").insert({
        intake_id: it.data.id,
        user_id: uid,
        engine_version: result.engineVersion,
        data_version: result.dataVersion,
        result,
        item_ids: result.items.map((i: { id: string }) => i.id),
        status: "needs_review",
      });
      if (pk.error) throw pk.error;
      return reply({ status: "received" });
    }

    return reply({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: "server" }, 500);
  }
});
