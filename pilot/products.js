// 試驗商品的「題庫＋規則式數位計畫」設定。此版本不呼叫 AI、也不保存個資。
export const catalog = {
  relax: {
    id: 'relax', label: '14 天放鬆練習', eyebrow: '日常練習・14 天',
    title: '每天留幾分鐘，建立自己的放鬆節奏',
    tagline: '用生活情境問卷，安排適合你時間的練習。心率紀錄是可選的自我觀察，不作診斷。',
    price: 1290, days: 14,
    questions: [
      { id: 'goal', text: '你最想在哪個時段安排練習？', options: [
        {value:'break',label:'工作中間，短暫休息'}, {value:'evening',label:'下班後，轉換節奏'},
        {value:'beforebed',label:'睡前，建立安靜的流程'} ] },
      { id:'minutes', text:'每天願意花幾分鐘？', options: [
        {value:'3',label:'3 分鐘'}, {value:'5',label:'5 分鐘'}, {value:'10',label:'10 分鐘'} ] },
      { id:'barrier', text:'過去最難持續的原因是？', options: [
        {value:'forget',label:'常常忘記'}, {value:'busy',label:'時間總是不夠'},
        {value:'distract',label:'很容易分心'}, {value:'unsure',label:'不知道怎麼開始'} ] },
      { id:'format', text:'你喜歡怎麼接受練習引導？', options: [
        {value:'audio',label:'聽語音'}, {value:'visual',label:'看動畫'},
        {value:'text',label:'讀簡短文字'} ] },
      { id:'reminder', text:'哪個時段提醒最不打擾你？', options: [
        {value:'morning',label:'早上'}, {value:'noon',label:'午休前後'},
        {value:'night',label:'晚上'}, {value:'none',label:'暫時不提醒'} ] }
    ]
  },
  stage: {
    id: 'stage', label: '7 天重要場合準備', eyebrow: '重要時刻・7 天',
    title: '面對重要場合，先把能準備的事情準備好',
    tagline: '依你的場合、時程和困擾，安排每日演練。心率只作練習前的可選觀察，不代表表現或心理狀態。',
    price: 1490, days: 7,
    questions: [
      { id:'occasion', text:'你正準備哪一種場合？', options: [
        {value:'interview',label:'求職面試'}, {value:'presentation',label:'公開簡報'},
        {value:'pitch',label:'客戶提案'}, {value:'conversation',label:'重要的一對一對話'} ] },
      { id:'when', text:'距離重要場合還有多久？', options: [
        {value:'soon',label:'1–3 天'}, {value:'week',label:'4–7 天'},
        {value:'later',label:'8 天以上'} ] },
      { id:'challenge', text:'你最想改善什麼？', options: [
        {value:'structure',label:'內容不夠有條理'}, {value:'pace',label:'講太快／容易卡住'},
        {value:'questions',label:'不知道怎麼應對提問'}, {value:'start',label:'開頭不知道怎麼講'} ] },
      { id:'minutes', text:'每天能投入多少時間？', options: [
        {value:'5',label:'5 分鐘'}, {value:'10',label:'10 分鐘'}, {value:'15',label:'15 分鐘'} ] },
      { id:'format', text:'想要哪種練習形式？', options: [
        {value:'outline',label:'有結構的文字提綱'}, {value:'rehearsal',label:'自己開口演練'},
        {value:'both',label:'兩種都要'} ] }
    ]
  }
};
const label = (p, id, value) => p.questions.find(q=>q.id===id)?.options.find(o=>o.value===value)?.label || '';
export function createPreview(p, a) {
  const minutes = Number(a.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('缺少每日練習時間');
  if (p.id === 'relax') {
    const context = {
      break:'工作休息時', evening:'下班後', beforebed:'睡前'
    }[a.goal];
    const focus = {
      forget:'每天在固定時段設定提示；不用補做錯過的練習',
      busy:'從短版開始；不追求一次做滿',
      distract:'先關閉通知，把注意力帶回眼前的引導',
      unsure:'照著預先安排好的步驟開始，不用自己挑選內容'
    }[a.barrier];
    const format = {audio:'語音引導',visual:'視覺節奏提示',text:'短文字引導'}[a.format];
    const kinds = [
      '找到安靜的坐姿，觀察自然呼吸，不必改變節奏',
      '放鬆肩膀與手部，留意接觸椅子的感覺',
      '以舒服的速度做緩和呼吸，不憋氣、不強迫',
      '短暫移開螢幕，注意周圍三個聲音',
      '記下今天什麼時候最需要休息',
      '練習在任務之間留一段短暫空白',
      '回顧哪些練習比較容易持續'
    ];
    return {
      headline:`適合你的 ${p.days} 天・每天 ${minutes} 分鐘練習`,
      reason:`你選擇在「${context}」練習，偏好「${format}」。因此計畫以固定時段、可完成的小任務為主。`,
      notes:[focus, a.reminder==='none'?'你選擇不接收提醒':`你偏好的提醒時段：${label(p,'reminder',a.reminder)}（正式版才會提供通知設定）`],
      tasks:Array.from({length:14},(_,i)=>({day:i+1,title:`第 ${i+1} 天・${kinds[i%kinds.length]}`,detail:`建議 ${minutes} 分鐘，以${format}進行；結束後記下自己的感受即可。`}))
    };
  }
  const scenes={interview:'面試',presentation:'簡報',pitch:'客戶提案',conversation:'重要對話'};
  const focuses={
    structure:'先寫出一句核心訊息，再安排三個支持要點',
    pace:'分段說話，在每一個重點後自然停頓',
    questions:'先準備最可能被問的三個問題，練習直接回答',
    start:'先練一句清晰的開場和這場對話的目的'
  };
  const lessons=[
    '釐清目標：寫下一句你最想讓對方記住的話',
    '建立架構：以開頭、三個重點和結尾組成提綱',
    '大聲練習：用手機計時，完整說一遍',
    '問題演練：回答三個常見或可能出現的問題',
    '內容精簡：刪去不必要的資訊，保留關鍵例子',
    '情境模擬：照實際場合的時間限制練習',
    '最後檢查：確認開場、關鍵內容及結尾'
  ];
  const format={outline:'文字提綱',rehearsal:'口說演練',both:'文字提綱加口說演練'}[a.format];
  return {
    headline:`你的 ${p.days} 天${scenes[a.occasion]}準備方案`,
    reason:`你正在準備「${scenes[a.occasion]}」，希望改善「${label(p,'challenge',a.challenge)}」。練習會優先圍繞你能直接準備的表達內容。`,
    notes:[`每日 ${minutes} 分鐘・${format}`,focuses[a.challenge],a.when==='soon'?'重要場合只剩 1–3 天：請優先完成前面三個任務，無須急著全部補做。':'每天循序練習，不需追求一次就完美。'],
    tasks:lessons.map((title,i)=>({day:i+1,title:`第 ${i+1} 天・${title}`,detail:`建議 ${minutes} 分鐘，以${format}完成今天的任務。`}))
  };
}
