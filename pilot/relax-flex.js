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
// Numbered step row used on the scan invitation and the first-day card.
const relaxStep = (n, text) => ({type:'box',layout:'horizontal',spacing:'md',contents:[
  {type:'text',text:String(n),size:'md',weight:'bold',color:relaxColors.deep,flex:0,wrap:true},paragraph(text,{size:'sm'})]});
export function relaxScanCard(data, uri) {
  const message = card('看看你放鬆前後的心跳｜約 2 分鐘，也可以略過。','看看你放鬆前後的心跳',[],[
    action(uri?'開始（約 2 分鐘）':'量一下',uri||data('rlx|scan|yes'),true,!!uri),action('略過，直接看計畫',data('rlx|scan|skip'))]);
  message.contents.header.contents[0].text='5 題完成・最後一步';
  message.contents.body.contents=[
    paragraph('約 2 分鐘，手機會一步一步帶你做：',{size:'sm'}),
    relaxStep(1,'先量一次心跳（30 秒）'),relaxStep(2,'跟著圓圈慢慢呼吸（1 分鐘）'),relaxStep(3,'再量一次（30 秒）'),
    paragraph('做完回到這裡，會收到你的放鬆報告。',{size:'sm'}),
    relaxLine({note:'影像只在手機上處理、不上傳。不量也會拿到一樣的計畫。'})];
  return message;
}
// Report carousel pieces. Heart rate is self-observation only and never changes the plan.
const relaxBubble = (eyebrow, title, contents, footer) => ({ type:'bubble', size:'mega',
  header:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'18px',spacing:'xs',contents:[
    paragraph(eyebrow,{size:'xs',color:relaxColors.deep,weight:'bold'}),paragraph(title,{size:'lg',weight:'bold'})]},
  body:{type:'box',layout:'vertical',backgroundColor:relaxColors.surface,paddingAll:'18px',spacing:'md',contents},
  ...(footer?{footer:{type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,paddingAll:'12px',spacing:'sm',contents:footer}}:{})});
const relaxBig = (text, label, color) => ({type:'box',layout:'vertical',flex:1,contents:[
  {type:'text',text,size:'3xl',weight:'bold',color,align:'center',wrap:true},{type:'text',text:label,size:'xs',color:relaxColors.muted,align:'center',wrap:true}]});
const relaxDelta = (b, a) => b - a >= 3 ? `慢了 ${b-a} 下` : b - a <= -3 ? `快了 ${a-b} 下` : '差不多';
function relaxHeartBubble(eyebrow, before, after, first) {
  const b=Math.round(before), a=Number.isFinite(after)?Math.round(after):null, d=a===null?0:b-a;
  const numbers=a===null?[relaxBig(String(b),'次／分',relaxColors.deep)]:[relaxBig(String(b),'放鬆前',relaxColors.muted),
    {type:'text',text:'→',size:'xl',color:relaxColors.muted,align:'center',gravity:'center',flex:0,wrap:true},relaxBig(String(a),'放鬆後',relaxColors.deep)];
  const message=a===null?'這次只量了一次。下次可以試試「先量、慢呼吸 1 分鐘、再量」，看看自己的變化。'
    :d>=3?`慢了 ${d} 下。慢慢呼吸時，心跳跟著放緩是很常見的反應，代表你這一分鐘真的停下來了。`
    :d<=-3?`這次快了 ${-d} 下，可能剛好說話或換了姿勢。下次先靜坐一下再量看看。`
    :'變化不大，這很常見。多練幾天，身體會慢慢熟悉這個節奏。';
  const compare=first&&a!==null?[{type:'box',layout:'vertical',spacing:'xs',contents:[
    paragraph(`第 1 天：${Math.round(first.before)} → ${Math.round(first.after)}（${relaxDelta(Math.round(first.before),Math.round(first.after))}）`,{size:'sm'}),
    paragraph(`今天：${b} → ${a}（${relaxDelta(b,a)}）`,{size:'sm',weight:'bold',color:relaxColors.deep})]}]:[];
  return relaxBubble(eyebrow,first?'和第 1 天的你比一比':a===null?'你的心跳':'這一分鐘，你的心跳',[
    {type:'box',layout:'horizontal',backgroundColor:relaxColors.sage,cornerRadius:'12px',paddingAll:'14px',contents:numbers},
    ...compare,paragraph(message,{size:'sm'}),
    relaxLine({note:'只是自我觀察，不是醫療檢測，也不影響你的計畫；睡眠、咖啡、量的時間都會影響數字。'})]);
}
export function relaxHeartCard(before, after, first) {
  return {type:'flex',altText:Number.isFinite(after)?`這一分鐘，你的心跳：${Math.round(before)} → ${Math.round(after)}`:`你的心跳：每分鐘 ${Math.round(before)} 下`,
    contents:relaxHeartBubble('放鬆反應',before,after,first)};
}
// overview=true shades week 1 (report map); otherwise days already passed are shaded.
const relaxDayGrid = (current, overview) => [0,7].map(start=>({type:'box',layout:'horizontal',spacing:'xs',contents:Array.from({length:7},(_,k)=>{
  const day=start+k+1, check=day===7||day===14, now=day===current, past=day<current;
  return {type:'box',layout:'vertical',flex:1,cornerRadius:'6px',paddingAll:'4px',
    backgroundColor:now?relaxColors.deep:(overview?day<=7:past)?relaxColors.sage:relaxColors.canvas,
    ...(check?{borderWidth:'2px',borderColor:relaxColors.forest}:{}),
    contents:[{type:'text',text:String(day),size:'xs',align:'center',wrap:true,color:now?'#FFFFFF':relaxColors.ink,weight:check?'bold':'regular'}]};
})}));
export function relaxReport(preview, data, heart) {
  const cards=[];
  if (heart) cards.push(relaxHeartBubble('放鬆反應',heart.before,heart.after,heart.first));
  cards.push(relaxBubble('你的放鬆類型',preview.type.name,[paragraph(preview.type.intro,{size:'sm'}),
    paragraph('所以你的計畫會：',{size:'sm',weight:'bold',color:relaxColors.deep}),...preview.type.points.map(x=>paragraph('・'+x,{size:'sm'}))]));
  cards.push(relaxBubble('14 天地圖','兩週，一步一步來',[...relaxDayGrid(1,true),
    ...preview.weeks.map(w=>paragraph(w.title+'\n'+w.detail,{size:'sm'})),
    paragraph('第 7、14 天・前後對比\n再量一次，和今天的你比一比',{size:'sm',color:relaxColors.deep,weight:'bold'})]));
  cards.push(relaxBubble('今天就開始',`第 1 天・${preview.headline.match(/每天 (\d+) 分鐘/)[1]} 分鐘`,[
    ...preview.firstDay.map((x,i)=>relaxStep(i+1,x)),
    {type:'box',layout:'vertical',backgroundColor:relaxColors.canvas,cornerRadius:'12px',paddingAll:'12px',contents:[
      paragraph('完整 14 天計畫',{size:'xs',color:relaxColors.muted}),paragraph('NT$1,290',{size:'xl',weight:'bold'})]},
    relaxLine({note:'目前只開放登記，不會收費，也不會成立訂單。'})],
    [action('我有興趣',data('rlx|interest'),true),action('刪除我的資料',data('rlx|delete'))]));
  const n=cards.length;
  cards.forEach((c,i)=>{c.header.contents[0].text=`${i+1}/${n}・`+c.header.contents[0].text;});
  return [{type:'text',text:`你的放鬆報告來了，往右滑看 ${n} 張 ›`},
    {type:'flex',altText:`你的放鬆報告｜${preview.type.name}・${preview.headline}`,contents:{type:'carousel',contents:cards}}];
}
// 「我的計畫」：今天是第幾天、今天做什麼。
export function relaxTodayCard(preview, day, data) {
  const t=preview.tasks[day-1];
  return {type:'flex',altText:`第 ${day} 天｜${t.title}`,contents:relaxBubble(`${preview.type.name}・第 ${day} 天`,t.title.replace(/^第 \d+ 天・/,'今天：'),[
    paragraph(t.detail,{size:'sm'}),...relaxDayGrid(day,false),
    ...(day===7||day===14?[paragraph('今天是前後對比日：點下方主選單的「心跳前後對比」。',{size:'sm',color:relaxColors.deep,weight:'bold'})]:[])],
    [action('再看一次報告',data('rlx|report')),action('刪除我的資料',data('rlx|delete'))])};
}
