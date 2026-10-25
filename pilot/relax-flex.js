// LINE Flex builders: no user identity, credentials or network calls.
export const relaxColors = { canvas:'#F6F1EA', surface:'#FFFFFF', forest:'#2F7D5B', deep:'#1F5C42', ink:'#1E2A24', muted:'#52655B', sage:'#E4EDE7', line:'#E3DACB' };
const paragraph = (text, extra = {}) => ({ type:'text', text, wrap:true, size:'md', color:relaxColors.ink, ...extra });
// A line is either plain text or {note:'...'} for the small, muted fine print at the end of a card.
const relaxLine = x => typeof x === 'string' ? paragraph(x) : paragraph(x.note,{size:'xs',color:relaxColors.muted});
const action = (label, data, primary = false, uri = false) => ({ type:'button', style:primary?'primary':'link', height:'md', color:relaxColors.deep, action:uri?{type:'uri',label,uri:data}:{type:'postback',label,data,displayText:label} });
const card = (altText, title, lines, buttons) => ({
  type:'flex', altText,
  contents:{ type:'bubble', size:'mega',
    header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'20px',spacing:'sm',contents:[paragraph('DEERLY・14 天放鬆練習',{size:'xs',color:relaxColors.deep,weight:'bold'}),paragraph(title,{size:'xl',weight:'bold'})]},
    body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'20px',spacing:'md',contents:lines.map(relaxLine)},
    footer:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'16px',spacing:'sm',contents:buttons}
  }
});
export const relaxPrivacy = [
  '【資料怎麼使用】\n我們只記錄你的 5 題回答、同意時間，以及你是否對方案有興趣，用來排出你的練習計畫。這些資料不和 Deerly 其他服務共用，只有 Deerly 管理者看得到。',
  '心率量測可以略過，不影響計畫。前鏡頭影像只在你的手機上處理、不會上傳；量測頁會另外詢問是否保存數字。心率不是壓力、情緒或疾病的判斷。',
  '你的回答最多保存 30 天，隨時可以輸入「刪除我的資料」立即刪除（心率紀錄請在量測頁刪除）。目前不收費，也不會自動傳提醒；語音與動畫引導還在準備中。'
];
export function relaxWelcome() {
  return card('14 天放鬆練習｜回答 5 題，約 1 分鐘，排出你的練習計畫。','每天幾分鐘，留給自己',[
    '回答 5 題（約 1 分鐘），幫你排出 14 天、每天 3–10 分鐘的放鬆練習。',
    '想的話，也可以用手機前鏡頭量一下心跳。',
    {note:'按下同意後，會保存你的回答最多 30 天，隨時可以刪除。'}
  ],[action('同意並開始','rlx|start|yes',true),action('資料怎麼使用','rlx|privacy'),action('先不要','rlx|start|no')]);
}
export function relaxScanCard(data, uri) {
  return card('要量一下心跳嗎？約 30 秒，也可以略過。','要量一下心跳嗎？',[
    '用手機前鏡頭，大約 30 秒，不用穿戴裝置。',
    uri?'量完按「回聊天室」，就會看到你的計畫。':'不量也會拿到一樣的計畫。',
    {note:'影像只在手機上處理、不上傳；量測頁會另外詢問是否保存。這不是醫療檢測。'}
  ],[action(uri?'開始量測':'量一下',uri||data('rlx|scan|yes'),true,!!uri),action('略過，直接看計畫',data('rlx|scan|skip'))]);
}
// Before/after heart rate around one minute of slow breathing. Self-observation only, never feeds the plan.
export function relaxHeartCard(before, after) {
  const b=Math.round(before), a=Number.isFinite(after)?Math.round(after):null, d=a===null?0:b-a;
  const big=(text,label,color)=>({type:'box',layout:'vertical',flex:1,contents:[
    {type:'text',text,size:'3xl',weight:'bold',color,align:'center',wrap:true},{type:'text',text:label,size:'xs',color:relaxColors.muted,align:'center',wrap:true}]});
  const numbers=a===null?[big(String(b),'次／分',relaxColors.deep)]:[
    big(String(b),'放鬆前',relaxColors.muted),
    {type:'text',text:'→',size:'xl',color:relaxColors.muted,align:'center',gravity:'center',flex:0,wrap:true},
    big(String(a),'放鬆後',relaxColors.deep)];
  const message=a===null?'這次只量了一次。下次可以試試「先量、慢呼吸 1 分鐘、再量」，看看自己的變化。'
    :d>=3?`慢了 ${d} 下。慢慢呼吸時，心跳跟著放緩是很常見的反應。`
    :d<=-3?`這次快了 ${-d} 下，可能剛好說話或換了姿勢。下次先靜坐一下再量看看。`
    :'變化不大，這很常見。多練幾天，身體會慢慢熟悉這個節奏。';
  return {type:'flex',altText:a===null?`你的心跳：每分鐘 ${b} 下`:`這一分鐘，你的心跳：${b} → ${a}`,
    contents:{type:'bubble',size:'mega',
      header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'20px',spacing:'sm',contents:[
        paragraph('DEERLY・14 天放鬆練習',{size:'xs',color:relaxColors.deep,weight:'bold'}),paragraph(a===null?'你的心跳':'這一分鐘，你的心跳',{size:'xl',weight:'bold'})]},
      body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'20px',spacing:'lg',contents:[
        {type:'box',layout:'horizontal',backgroundColor:relaxColors.sage,cornerRadius:'12px',paddingAll:'16px',contents:numbers},
        paragraph(message),
        paragraph('計畫第 7 天和第 14 天會再做一次前後對比，看看兩週來的變化。'),
        relaxLine({note:'只是自我觀察，不是醫療檢測，也不影響你的計畫；單次差異也可能來自量測誤差。'})]}}};
}
export function relaxResultCard(preview) {
  return card('你的 14 天放鬆計畫｜'+preview.headline,'你的 14 天放鬆計畫',[
    preview.headline,preview.reason,...preview.notes,
    {note:'練習中覺得不舒服就停下來，不需要憋氣或刻意改變呼吸。'}
  ],[action('資料怎麼使用','rlx|privacy')]);
}
export function relaxInterestCard(preview, data) {
  return card('先試前兩天｜完整 14 天 NT$1,290，目前只開放登記。','先試前兩天',[
    ...preview.tasks.slice(0,2).map(t=>t.title+'\n'+t.detail),
    '完整 14 天計畫 NT$1,290',
    {note:'目前只開放登記，不會收費，也不會成立訂單。'}
  ],[action('我有興趣',data('rlx|interest'),true),action('再看一次計畫',data('rlx|resume')),action('刪除我的資料',data('rlx|delete'))]);
}
