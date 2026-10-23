// LINE 登入與呼叫後端 intake 函式。問卷頁與審核頁共用。
export const LIFF_ID = '2012160129-CwL40nTW';
export const API = 'https://gokvjcwjkhhnmckbbyxl.supabase.co/functions/v1/intake';

// 回傳 true 代表已登入；未登入時會跳去 LINE 登入頁（回來後重新載入本頁）
export async function login() {
  if (!window.liff) throw new Error('LIFF SDK 未載入');
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return false; }
  return true;
}

export async function call(action, extra = {}) {
  const idToken = liff.getIDToken();
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, idToken, ...extra }),
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空回應 */ }
  return { status: r.status, body };
}
