// LINE Flex builders: no user identity, credentials or network calls.
export const relaxColors = { canvas:'#F6F1EA', surface:'#FFFFFF', forest:'#2F7D5B', deep:'#1F5C42', ink:'#1E2A24', muted:'#52655B', sage:'#E4EDE7', line:'#E3DACB' };
const paragraph = (text, extra = {}) => ({ type:'text', text, wrap:true, size:'md', color:relaxColors.ink, ...extra });
const action = (label, data, primary = false, uri = false) => ({ type:'button', style:primary?'primary':'link', height:'md', color:primary?relaxColors.deep:relaxColors.deep, action:uri?{type:'uri',label,uri:data}:{type:'postback',label,data,displayText:label} });
const card = (altText, title, lines, buttons) => ({
  type:'flex', altText,
  contents:{ type:'bubble', size:'mega',
    header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'20px',spacing:'sm',contents:[paragraph('DEERLY / LAB',{size:'sm',color:relaxColors.deep,weight:'bold'}),paragraph(title,{size:'xl',weight:'bold'})]},
    body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'20px',spacing:'md',contents:lines.map(x=>paragraph(x))},
    footer:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'16px',spacing:'sm',contents:buttons}
  }
});
export const relaxPrivacy = [
  '【放鬆測試資料說明｜relax-pilot-2026-10】\n只供受邀內部測試。記錄五題偏好、LINE 帳號對應、同意版本與時間，以及購買意願時間，用固定規則產生預覽；不與保健品問卷共用同意或答案。僅服務管理者可存取。',
  '心率量測可略過，不影響方案。前鏡頭影像僅在手機量測頁處理、不上傳；原量測頁另行取得同意並保存數字。只有另選量測時，聊天室才暫時讀取本次合格的新心率，不複製到放鬆問卷。不是壓力、情緒或疾病診斷。',
  '放鬆測試紀錄自同意起最多保留 30 天，不因作答延長；測試管理者須於獨立測試資料庫執行清理。可輸入「刪除放鬆測試資料」立即刪除問卷與意願；原心率須在量測頁另行刪除。目前無收款、無正式課程、無自動通知；語音／動畫僅記錄偏好。不同意不建立放鬆紀錄。'
];
export function relaxWelcome() {
  return card('14 天放鬆練習｜5 題約 1 分鐘，心率可略過。請閱讀說明後選擇是否同意。','14 天放鬆練習',[
    '每天 3–10 分鐘，替自己留一點放鬆時間。',
    '5 題／約 1 分鐘・心率量測可略過',
    '同意後會記錄偏好與意願，保存最多 30 天，隨時可刪除。僅為預覽，尚未開放購買。'
  ],[action('同意，開始五題','rlx|start|yes',true),action('完整資料說明','rlx|privacy'),action('先不要','rlx|start|no')]);
}
export function relaxScanCard(data, uri) {
  return card('選用心率量測｜約 30 秒，可直接略過並取得相同方案。','用前鏡頭看看心跳',[
    '約 30 秒，不用穿戴裝置。原始影像只在手機量測頁處理。',
    '不是壓力、情緒或疾病診斷；不量也能取得相同方案。',
    uri?'請在量測頁另行同意保存。量完按「回聊天室」繼續；無法量測也能略過。':'請先選擇是否量測，量測頁的資料保存同意會另外詢問。'
  ],[action(uri?'開始心率量測':'選擇量測心率',uri||data('rlx|scan|yes'),true,!!uri),action('略過，看我的方案',data('rlx|scan|skip'))]);
}
export function relaxResultCard(preview, bpm) {
  const observed = Number.isFinite(bpm)?[`本次心率約 ${Math.round(bpm)} 次／分鐘，僅供參考，不影響練習安排。`]:[];
  return card('你的 14 天放鬆計畫預覽｜'+preview.headline+'。'+preview.reason,'你的 14 天放鬆計畫',[
    preview.headline,preview.reason,...preview.notes,...observed,
    '前兩天可先試短文字練習；語音、動畫與完整課程尚未提供。感到不適請停止，不必憋氣或強迫調整呼吸。'
  ],[action('完整資料說明','rlx|privacy')]);
}
export function relaxInterestCard(preview, data) {
  return card('前兩天練習預覽｜測試價 NT$1,290。尚未開放購買，不會扣款。','先試前兩天',[
    ...preview.tasks.slice(0,2).map(t=>t.title+'\n'+t.detail),
    '完整 14 天方案測試價 NT$1,290',
    '尚未開放購買／不會扣款。按鈕只記錄意願，不產生訂單，也不會啟用提醒。'
  ],[action('這個價格，我有興趣',data('rlx|interest'),true),action('再看一次方案',data('rlx|resume')),action('刪除放鬆測試資料',data('rlx|delete'))]);
}
