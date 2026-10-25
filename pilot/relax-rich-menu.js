// Shared image geometry + per-question postbacks. No LINE calls here.
export const relaxMenuVersion = 'relax-menu-20261025-v1';
export const relaxMenuSize = {width:2500,height:1686};
export const relaxMenuLabels = {
  goal:['工作空檔','下班後','睡前'],
  minutes:['3 分鐘','5 分鐘','10 分鐘'],
  barrier:['常常忘記','總是太忙','容易分心','不知怎麼開始'],
  format:['聽語音','看動畫','讀短文字'],
  reminder:['早上','午休前後','晚上','暫不提醒']
};
export function relaxMenuLayout(question) {
  const columns=2,rows=2;
  const pad=110,gap=34,top=520,bottom=1280;
  const width=Math.floor((2500-pad*2-gap*(columns-1))/columns),height=Math.floor((bottom-top-gap*(rows-1))/rows);
  return question.options.map((o,i)=>({value:o.value,label:relaxMenuLabels[question.id][i],bounds:{x:pad+(i%columns)*(width+gap),y:top+Math.floor(i/columns)*(height+gap),width:question.options.length===3&&i===2?2280:width,height}}));
}
// One shared menu per question (created once on the test bot, then only linked per user).
// Taps carry the question number; the handler ignores taps that no longer match the current step.
export const relaxMenuSet = 'relax-static-v4';
export function relaxMenuDefinition(question,step) {
  const menu=data=>`${data}~menu`;
  const areas=relaxMenuLayout(question).map(o=>({bounds:o.bounds,action:{type:'postback',data:menu(`rlx|answer|${step}|${o.value}`),displayText:o.label}}));
  if(step>0)areas.push({bounds:{x:110,y:1340,width:1090,height:310},action:{type:'postback',data:menu(`rlx|back|${step}`),displayText:'上一題'}});
  areas.push({bounds:{x:1300,y:1340,width:1090,height:310},action:{type:'postback',data:menu(`rlx|pause|${step}`),displayText:'先暫停'}});
  return {size:relaxMenuSize,selected:true,name:`${relaxMenuSet}-${question.id}`,chatBarText:'放鬆練習・點這裡作答',areas};
}
