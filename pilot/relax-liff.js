// Shared, testable adapter around the existing LIFF measurement page.
export function relaxFlowFromSearch(search) {
  const params = new URLSearchParams(search);
  const state = params.get('liff.state');
  let candidate;
  try { candidate = params.get('relaxPilot') || (state ? new URL(state, 'https://example.invalid').searchParams.get('relaxPilot') : null); } catch { return null; }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate || '') ? candidate : null;
}
export async function notifyRelaxScan({flow, saved, quality, liffClient}) {
  if (!saved || !Number.isFinite(quality) || quality < 0.35) return '尚未取得已保存的合格心率；可以回聊天室略過，不影響方案。';
  try {
    if (!liffClient.isInClient()) return '請回 LINE 聊天室，點「我量好了」繼續；也可以略過。';
    await liffClient.sendMessages([{type:'text',text:`放鬆量測完成 ${flow}`}]);
    return '已通知聊天室。按「回聊天室」查看方案。';
  } catch {
    return '已保存，但無法自動通知。請回聊天室點「我量好了」，或直接略過。';
  }
}
