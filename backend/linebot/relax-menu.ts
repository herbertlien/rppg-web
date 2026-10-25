// Test-only Rich Menu adapter. Official Deerly menus are never managed by this adapter.
// Pure image geometry is embedded separately from pilot/relax-rich-menu.js.
const RELAX_MENU_TEST_PROJECT = "https://rswcmlujwcwxvsffzise.supabase.co";
const RELAX_MENU_TEST_SITE = "https://glittery-longma-b8be7c.netlify.app";
const relaxMenuTestScope = () => Deno.env.get("RELAX_ISOLATED_TEST") === "1"
  && (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") === RELAX_MENU_TEST_PROJECT
  && LIFF_URL === "https://liff.line.me/2012194363-LYirSkEL";
const relaxMenusEnabled = () => relaxMenuTestScope() && Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED") === "1";
const RELAX_MENU_BUILD = "relax-menu-static-v4";
function relaxMenuFailure(e: unknown): string {
  const message=e instanceof Error?e.message:"";
  if(/^MENU_[A-Z_0-9]+$/.test(message))return message;
  if(message.includes("identity mismatch"))return "MENU_WRONG_BOT";
  if(message.includes("verify test bot"))return "MENU_BOT_AUTH_FAILED";
  if(message.includes("image unavailable"))return "MENU_IMAGE_UNAVAILABLE";
  if(message.includes("Invalid menu PNG")||message.includes("dimensions"))return "MENU_IMAGE_INVALID";
  if(e && typeof e==="object" && "code" in e && typeof e.code==="string" && /^[A-Z0-9]+$/.test(e.code))return "MENU_DATABASE_"+e.code;
  return "MENU_OPERATION_FAILED";
}
async function relaxMenuDiagnose(sub: string, token: string) {
  if(!relaxAllowed(sub))return reply(token,[{type:"text",text:"選單診斷只開放受邀測試者。"}]);
  const lines=["選單診斷｜"+RELAX_MENU_BUILD,
    "測試環境核對："+(relaxMenuTestScope()?"通過":"未通過"),
    "Rich Menu 開關："+(Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED")==="1"?"已開啟":"未開啟，請設 RELAX_PILOT_RICH_MENU_ENABLED=1")];
  if(!relaxMenuTestScope())return reply(token,[{type:"text",text:lines.join("\n")}]);
  try{await relaxMenuIdentity();lines.push("測試官方帳號：通過");}catch(e){lines.push("測試官方帳號："+relaxMenuFailure(e));return reply(token,[{type:"text",text:lines.join("\n")}]);}
  const uid=await findUser(sub,false);
  if(uid){
    const row=await db.from("digital_relax_pilot_sessions").select("current_rich_menu_id,previous_rich_menu_id,rich_menu_captured").eq("user_id",uid).maybeSingle();
    lines.push("選單資料欄位："+(row.error?relaxMenuFailure(row.error):"通過"));
  }else lines.push("問卷紀錄：尚未同意開始");
  try{
    const list=await relaxMenuApi("/v2/bot/richmenu/list");
    const n=(list?.richmenus??[]).filter((m: {name?: string})=>m?.name?.startsWith(relaxMenuSet+"-")).length;
    lines.push("五題共用選單："+(n?`已建立 ${n}/5`:"尚未建立（第一次作答時自動建立）"));
  }catch(e){lines.push("五題共用選單："+relaxMenuFailure(e));}
  try{
    const res=await fetch(`${RELAX_MENU_TEST_SITE}/pilot/relax-menus/goal.png?v=${relaxMenuVersion}`,{redirect:"error"});
    const bytes=new Uint8Array(await res.arrayBuffer());
    lines.push("第一題圖片：HTTP "+res.status+(bytes.length>=24&&bytes.slice(0,8).join(",")==="137,80,78,71,13,10,26,10"?"，PNG 正確":"，不是有效 PNG"));
  }catch{lines.push("第一題圖片：連線或重新導向失敗");}
  return reply(token,[{type:"text",text:lines.join("\n")}]);
}
let relaxMenuBotCheck: Promise<void> | null = null;
async function relaxMenuIdentity() {
  if (!relaxMenuTestScope()) throw new Error("Rich Menu is restricted to the isolated test project");
  const expected = "@607idvzb"; // user-confirmed test official account, never overridable by a secret
  if (!/^@[A-Za-z0-9._-]+$/.test(expected)) throw new Error("Missing test bot basic ID");
  if (!relaxMenuBotCheck) relaxMenuBotCheck = (async () => {
    const res = await fetch("https://api.line.me/v2/bot/info", {headers:{authorization:`Bearer ${TOKEN}`}});
    if (!res.ok) throw new Error("MENU_BOT_HTTP_"+res.status);
    const bot = await res.json();
    if (bot.basicId !== expected) throw new Error("Test bot identity mismatch; menu changes refused");
  })().catch(e => { relaxMenuBotCheck = null; throw e; });
  await relaxMenuBotCheck;
}
async function relaxMenuApi(path: string, method="GET", body?: unknown, image=false) {
  await relaxMenuIdentity();
  const host = image ? "api-data.line.me" : "api.line.me";
  const res = await fetch(`https://${host}${path}`, {method,
    headers:{authorization:`Bearer ${TOKEN}`,...(body!==undefined?{"content-type":image?"image/png":"application/json"}:{})},
    body: body===undefined?undefined:image?body as Uint8Array:JSON.stringify(body)});
  if (res.status===404 && method==="GET") return null;
  if (!res.ok) {
    const stage=image?"UPLOAD":path==="/v2/bot/richmenu"?"CREATE":path==="/v2/bot/richmenu/list"?"LIST":path.includes("/user/")?(method==="GET"?"LOOKUP":"LINK"):"CLEANUP";
    throw new Error(`MENU_${stage}_HTTP_${res.status}`);
  }
  const text=await res.text();return text?JSON.parse(text):{};
}
async function relaxMenuState(s: RelaxSession): Promise<RelaxSession | null> {
  const r=await db.from("digital_relax_pilot_sessions").select("*").eq("user_id",s.user_id).eq("flow_id",s.flow_id).maybeSingle();
  if(r.error)throw r.error;return r.data;
}
// Menus made per user by the v1–v3 builds; the shared v4 menus are never deleted here.
async function relaxDeleteOwnedMenu(id: string | null | undefined, flow: string) {
  if(!id)return;
  const menu=await relaxMenuApi(`/v2/bot/richmenu/${id}`);
  if(menu?.name?.startsWith(`${relaxMenuVersion}-${flow}-`)) await relaxMenuApi(`/v2/bot/richmenu/${id}`,"DELETE");
}
async function relaxMenusRestore(sub: string, snapshot: RelaxSession) {
  if(!snapshot.current_rich_menu_id && !snapshot.rich_menu_captured)return;
  const s=await relaxMenuState(snapshot);if(!s||(!s.current_rich_menu_id&&!s.rich_menu_captured))return;
  await relaxMenuIdentity();
  const assigned=await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`);
  // If another flow has assigned a menu, do not overwrite it.
  if(assigned?.richMenuId===s.current_rich_menu_id){
    if(s.previous_rich_menu_id)await relaxMenuApi(`/v2/bot/user/${sub}/richmenu/${s.previous_rich_menu_id}`,"POST");
    else await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`,"DELETE"); // reveals account default; never changes default
  }
  const clear=await db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:null,previous_rich_menu_id:null,rich_menu_captured:false})
    .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("revision",s.revision).eq("current_rich_menu_id",s.current_rich_menu_id).select("*").maybeSingle();
  if(clear.error)throw clear.error;
  if(clear.data)await relaxDeleteOwnedMenu(s.current_rich_menu_id,s.flow_id);
}
// The five shared menus are found by name on the test bot, created once if missing, then cached per instance.
let relaxStaticMenus: Promise<Record<string,string>> | null = null;
function relaxMenuIds(): Promise<Record<string,string>> {
  if(!relaxStaticMenus)relaxStaticMenus=(async()=>{
    const list=await relaxMenuApi("/v2/bot/richmenu/list");
    const ids: Record<string,string>={};
    for(const m of list?.richmenus??[])if(typeof m?.name==="string"&&m.name.startsWith(relaxMenuSet+"-"))ids[m.name.slice(relaxMenuSet.length+1)]=m.richMenuId;
    for(const [step,question] of catalog.relax.questions.entries()){
      if(ids[question.id])continue;
      const asset=await fetch(`${RELAX_MENU_TEST_SITE}/pilot/relax-menus/${question.id}.png?v=${relaxMenuVersion}`,{redirect:"error"});
      if(!asset.ok)throw new Error("MENU_IMAGE_HTTP_"+asset.status);
      const bytes=new Uint8Array(await asset.arrayBuffer());
      if(bytes.length>1_000_000||bytes.length<24||bytes.slice(0,8).join(",")!=="137,80,78,71,13,10,26,10")throw new Error("Invalid menu PNG");
      const view=new DataView(bytes.buffer);if(view.getUint32(16)!==2500||view.getUint32(20)!==1686)throw new Error("Wrong menu image dimensions");
      const created=await relaxMenuApi("/v2/bot/richmenu","POST",relaxMenuDefinition(question,step));
      const id=created?.richMenuId;if(typeof id!=="string")throw new Error("Missing test menu ID");
      try{await relaxMenuApi(`/v2/bot/richmenu/${id}/content`,"POST",bytes,true);}
      catch(e){await relaxMenuApi(`/v2/bot/richmenu/${id}`,"DELETE").catch(()=>console.error("Test menu cleanup needs retry"));throw e;}
      ids[question.id]=id;
    }
    return ids;
  })().catch(e=>{relaxStaticMenus=null;throw e;});
  return relaxStaticMenus;
}
async function relaxMenusShow(sub: string, snapshot: RelaxSession): Promise<boolean> {
  if(!relaxMenusEnabled()){
    if(snapshot.current_rich_menu_id)await relaxMenusRestore(sub,snapshot);
    return false;
  }
  await relaxMenuIdentity();
  const s=await relaxMenuState(snapshot);if(!s||s.revision!==snapshot.revision||s.paused||s.status!=="quiz")return false;
  const ids=await relaxMenuIds(), id=ids[catalog.relax.questions[s.step].id];
  let previous=s.previous_rich_menu_id??null;
  if(!s.rich_menu_captured){
    // Remember the tester's own menu once so pause/finish can put it back.
    const assigned=(await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`))?.richMenuId??null;
    previous=Object.values(ids).includes(assigned)?null:assigned;
  }
  let query=db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:id,previous_rich_menu_id:previous,rich_menu_captured:true})
    .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("revision",s.revision);
  query=s.current_rich_menu_id?query.eq("current_rich_menu_id",s.current_rich_menu_id):query.is("current_rich_menu_id",null);
  const save=await query.select("*").maybeSingle();if(save.error)throw save.error;if(!save.data)return false;
  await relaxMenuApi(`/v2/bot/user/${sub}/richmenu/${id}`,"POST");
  if(s.current_rich_menu_id&&!Object.values(ids).includes(s.current_rich_menu_id)){
    try{await relaxDeleteOwnedMenu(s.current_rich_menu_id,s.flow_id);}catch{console.error("Test menu cleanup needs retry");}
  }
  return true;
}
async function relaxMenusTryRestore(sub: string, s: RelaxSession) {
  try{await relaxMenusRestore(sub,s);}catch{console.error("Test menu restore failed; retry with menu-stop command");}
}
