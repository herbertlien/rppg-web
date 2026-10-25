// Shared, testable adapter around the existing LIFF measurement page.
export function relaxFlowFromSearch(search) {
  const params = new URLSearchParams(search);
  const state = params.get('liff.state');
  let candidate;
  try { candidate = params.get('relaxPilot') || (state ? new URL(state, 'https://example.invalid').searchParams.get('relaxPilot') : null); } catch { return null; }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate || '') ? candidate : null;
}
export async function notifyRelaxScan({flow, saved, quality, liffClient}) {
  if (!saved || !Number.isFinite(quality) || quality < 0.35) return '這次沒有量到清楚的心跳。可以再量一次，或回聊天室直接看計畫。';
  try {
    if (!liffClient.isInClient()) return '請回 LINE 聊天室，輸入「我量好了」看結果。';
    await liffClient.sendMessages([{type:'text',text:'我量好了'}]);
    return '完成！按「回聊天室」看你的結果和計畫。';
  } catch {
    return '已記下。請回聊天室輸入「我量好了」看結果。';
  }
}
