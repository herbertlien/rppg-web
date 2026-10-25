// Test-only Rich Menu adapter. Official Deerly menus are never managed by this adapter.
// Pure image geometry is embedded separately from pilot/relax-rich-menu.js.
const RELAX_MENU_TEST_PROJECT = "https://rswcmlujwcwxvsffzise.supabase.co";
const RELAX_MENU_TEST_SITE = "https://glittery-longma-b8be7c.netlify.app";
const relaxMenuTestScope = () => Deno.env.get("RELAX_ISOLATED_TEST") === "1"
  && (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") === RELAX_MENU_TEST_PROJECT
  && LIFF_URL === "https://liff.line.me/2012194363-LYirSkEL";
const relaxMenusEnabled = () => relaxMenuTestScope() && Deno.env.get("RELAX_PILOT_RICH_MENU_ENABLED") === "1";
let relaxMenuBotCheck: Promise<void> | null = null;
async function relaxMenuIdentity() {
  if (!relaxMenuTestScope()) throw new Error("Rich Menu is restricted to the isolated test project");
  const expected = "@607idvzb"; // user-confirmed test official account, never overridable by a secret
  if (!/^@[A-Za-z0-9._-]+$/.test(expected)) throw new Error("Missing test bot basic ID");
  if (!relaxMenuBotCheck) relaxMenuBotCheck = (async () => {
    const res = await fetch("https://api.line.me/v2/bot/info", {headers:{authorization:`Bearer ${TOKEN}`}});
    if (!res.ok) throw new Error("Cannot verify test bot identity");
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
  if (!res.ok) throw new Error(`Test Rich Menu operation failed (${res.status})`);
  const text=await res.text();return text?JSON.parse(text):{};
}
async function relaxMenuState(s: RelaxSession): Promise<RelaxSession | null> {
  const r=await db.from("digital_relax_pilot_sessions").select("*").eq("user_id",s.user_id).eq("flow_id",s.flow_id).maybeSingle();
  if(r.error)throw r.error;return r.data;
}
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
async function relaxMenusShow(sub: string, snapshot: RelaxSession): Promise<boolean> {
  if(!relaxMenusEnabled()){
    if(snapshot.current_rich_menu_id)await relaxMenusRestore(sub,snapshot);
    return false;
  }
  await relaxMenuIdentity();
  const s=await relaxMenuState(snapshot);if(!s||s.revision!==snapshot.revision||s.paused||s.status!=="quiz")return false;
  const question=catalog.relax.questions[s.step], definition=relaxMenuDefinition(question,s);
  const assigned=await relaxMenuApi(`/v2/bot/user/${sub}/richmenu`);
  if(s.current_rich_menu_id && assigned?.richMenuId===s.current_rich_menu_id){
    const existing=await relaxMenuApi(`/v2/bot/richmenu/${s.current_rich_menu_id}`);
    if(existing?.name===definition.name)return true;
  }
  const asset=await fetch(`${RELAX_MENU_TEST_SITE}/pilot/relax-menus/${question.id}.png?v=${relaxMenuVersion}`,{redirect:"error"});
  if(!asset.ok)throw new Error("Test menu image unavailable");
  const bytes=new Uint8Array(await asset.arrayBuffer());
  if(bytes.length>1_000_000||bytes.length<24||bytes.slice(0,8).join(",")!=="137,80,78,71,13,10,26,10")throw new Error("Invalid menu PNG");
  const view=new DataView(bytes.buffer);if(view.getUint32(16)!==2500||view.getUint32(20)!==1686)throw new Error("Wrong menu image dimensions");
  const created=await relaxMenuApi("/v2/bot/richmenu","POST",definition);
  const id=created?.richMenuId;if(typeof id!=="string")throw new Error("Missing test menu ID");
  let linked=false, saved=false;
  try{
    await relaxMenuApi(`/v2/bot/richmenu/${id}/content`,"POST",bytes,true);
    let query=db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:id,
      previous_rich_menu_id:s.rich_menu_captured?s.previous_rich_menu_id:(assigned?.richMenuId??null),rich_menu_captured:true})
      .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("revision",s.revision);
    query=s.current_rich_menu_id?query.eq("current_rich_menu_id",s.current_rich_menu_id):query.is("current_rich_menu_id",null);
    const save=await query.select("*").maybeSingle();if(save.error)throw save.error;if(!save.data)return false;saved=true;
    const current=await relaxMenuState(s);if(!current||current.revision!==s.revision)throw new Error("Menu progress changed");
    await relaxMenuApi(`/v2/bot/user/${sub}/richmenu/${id}`,"POST");linked=true;
    // Only the previously generated menu owned by this run may be deleted.
    try{await relaxDeleteOwnedMenu(s.current_rich_menu_id,s.flow_id);}catch{console.error("Test menu cleanup needs retry");}
    return true;
  }finally{
    if(!linked){
      if(saved){
        const revert=await db.from("digital_relax_pilot_sessions").update({current_rich_menu_id:s.current_rich_menu_id??null,
          previous_rich_menu_id:s.previous_rich_menu_id??null,rich_menu_captured:s.rich_menu_captured??false})
          .eq("user_id",s.user_id).eq("flow_id",s.flow_id).eq("current_rich_menu_id",id);
        if(revert.error)console.error("Test menu rollback needs retry");
      }
      try{await relaxDeleteOwnedMenu(id,s.flow_id);}catch{console.error("Test menu cleanup needs retry");}
    }
  }
}
async function relaxMenusTryRestore(sub: string, s: RelaxSession) {
  try{await relaxMenusRestore(sub,s);}catch{console.error("Test menu restore failed; retry with menu-stop command");}
}
