// Supabase Edge Function：scan
// 前端送 LINE ID token，這裡向 LINE 驗證身分後才讀寫資料庫。資料庫金鑰只存在這裡。
import { createClient } from "npm:@supabase/supabase-js@2";

const LINE_CHANNEL_ID = "2012160129";
const ALLOWED_ORIGIN = "https://herbertlien.github.io";
const CONSENT_VERSION = "v0";

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

// 向 LINE 驗證 ID token，回傳使用者唯一 ID（sub）
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

// 只有「同意」時才建立使用者，同意前不留下任何資料
async function findUser(sub: string, create: boolean): Promise<string | null> {
  const found = await db.from("users").select("id").eq("line_sub", sub).maybeSingle();
  if (found.error) throw found.error;
  if (found.data) return found.data.id;
  if (!create) return null;
  const ins = await db.from("users").insert({ line_sub: sub }).select("id").single();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply({ error: "method" }, 405);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply({ error: "json" }, 400); }

  const sub = typeof b.idToken === "string" ? await verifyLine(b.idToken) : null;
  if (!sub) return reply({ error: "auth" }, 401);

  try {
    const uid = await findUser(sub, b.action === "consent");
    if (!uid) {
      // 還沒同意過：沒有任何資料可讀、可存、可刪
      if (b.action === "list") return reply({ scans: [], consented: false });
      if (b.action === "delete") return reply({ ok: true });
      return reply({ error: "consent" }, 403);
    }

    if (b.action === "consent") {
      const r = await db.from("consents").insert({ user_id: uid, version: CONSENT_VERSION });
      if (r.error) throw r.error;
      return reply({ ok: true });
    }

    if (b.action === "save") {
      const bpm = Number(b.bpm), quality = Number(b.quality);
      if (!(bpm >= 30 && bpm <= 220) || !(quality >= 0 && quality <= 1)) return reply({ error: "range" }, 400);
      const c = await db.from("consents").select("id").eq("user_id", uid).limit(1);
      if (c.error) throw c.error;
      if (!c.data?.length) return reply({ error: "consent" }, 403);
      const last = await db.from("scans").select("scanned_at").eq("user_id", uid)
        .order("scanned_at", { ascending: false }).limit(1);
      if (last.error) throw last.error;
      if (last.data?.length && Date.now() - new Date(last.data[0].scanned_at).getTime() < 20_000) {
        return reply({ error: "too_fast" }, 429);
      }
      const ins = await db.from("scans").insert({
        user_id: uid,
        bpm,
        quality,
        valid_frames: Number.isFinite(Number(b.validFrames)) ? Math.round(Number(b.validFrames)) : null,
        algo_version: String(b.algoVersion ?? "").slice(0, 32) || "unknown",
        device: String(b.device ?? "").slice(0, 32) || null,
      });
      if (ins.error) throw ins.error;
      return reply({ ok: true });
    }

    if (b.action === "list") {
      const r = await db.from("scans").select("scanned_at,bpm,quality")
        .eq("user_id", uid).order("scanned_at", { ascending: false }).limit(100);
      if (r.error) throw r.error;
      const c = await db.from("consents").select("id").eq("user_id", uid).limit(1);
      return reply({ scans: r.data, consented: !!c.data?.length });
    }

    if (b.action === "delete") {
      const r = await db.from("users").delete().eq("id", uid);
      if (r.error) throw r.error;
      return reply({ ok: true });
    }

    return reply({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: "server" }, 500);
  }
});
