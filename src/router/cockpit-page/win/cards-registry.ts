/** cockpit-page/win — B8b-client `settings`: the registry editor on the win runtime (spec 7/B8b).
 *  Page-scope ES5 (after scriptCore: esc in scope), needs `Win`, `WinT` and `WIN_HOST` ({fetch}). Group `settings`:
 *  the `editor` card `settings.registry-edit` (a monospace textarea holding the whole workers.yaml text from
 *  GET /cockpit/registry; header actions Validate, Diff, Save, Duplicate) and the `list` card `settings.registry-backups`
 *  (GET /cockpit/registry/backups, newest first, Restore with a two-click confirm). Save stays disabled until Validate has
 *  passed on exactly the text in the editor; validate/save/restore/duplicate results show in the editor card's status slot,
 *  the error list or the diff in its `diff` slot. The routes are the POST-only ones of src/router/cockpit-registry.ts.
 *  The state `WRG` and the logic take an io {get, post, status, paint} so a test drives them with a fake fetch; the
 *  card wiring below only reads/writes the textarea. Names are prefixed wrg*. */

export const WIN_REGISTRY_JS = String.raw`var WRG_ID="settings.registry-edit",WRG_BK="settings.registry-backups",WRG_ARM_MS=4000;
var WRG_INFO="The model registry (local_tiers and providers of workers.yaml). Validate checks the text; Save writes it atomically and keeps a timestamped backup; Save is only enabled after Validate passed on exactly this text.";
var WRG={hash:"",saved:"",text:"",passed:null,backups:[],diff:"",arm:null,dup:false,busy:false,loaded:false};
function wrgDirty(S){return S.text!==S.saved}
/** Save: true, or the reason it is disabled. */
function wrgCanSave(S){
 if(S.busy)return"working";
 if(!S.loaded)return"registry not loaded";
 if(!wrgDirty(S))return"no changes to save";
 if(S.passed!==S.text)return"validate this text first";
 return true;
}
function wrgCanCheck(S){return S.busy?"working":!S.loaded?"registry not loaded":true}
function wrgErrLines(errors){return(errors||[]).map(function(e){return"line "+e.line+(e.path?" · "+e.path:"")+": "+e.message}).join("\n")}
function wrgFail(io,e){io.status("err","no answer: "+(e&&e.message?e.message:String(e)));io.paint()}
/** Load the registry text (replaces the editor text unless it holds unsaved edits, or force) and the backups. */
function wrgLoad(S,io,force){
 return io.get("/cockpit/registry").then(function(r){
  var keep=wrgDirty(S)&&!force;
  S.hash=r.hash;S.saved=r.yaml;S.loaded=true;
  if(!keep){S.text=r.yaml;S.passed=null;S.diff=""}
  io.paint(!keep);
  return wrgBackups(S,io);
 }).catch(function(e){wrgFail(io,e)});
}
function wrgBackups(S,io){
 return io.get("/cockpit/registry/backups").then(function(r){S.backups=r.backups||[];io.paint()}).catch(function(e){wrgFail(io,e)});
}
/** Validate (and Diff): POST validate with exactly the editor text; a pass records that text as validated. */
function wrgValidate(S,io){
 var text=S.text;
 S.busy=true;io.status("pending","validating…");io.paint();
 return io.post("/cockpit/registry/validate",{yaml:text,baseHash:S.hash}).then(function(r){
  S.busy=false;
  if(r.stale){S.passed=null;S.diff="";io.status("err","changed on disk - reload")}
  else if(r.ok){
   S.passed=text;
   S.diff=(r.diff||[]).join("\n");
   io.status("ok","valid · "+((r.diff||[]).length?(r.diff||[]).length+" changed lines":"no changes"));
  }else{
   S.passed=null;
   S.diff=wrgErrLines(r.errors);
   io.status("err",(r.errors||[]).length+" error"+((r.errors||[]).length===1?"":"s")+" · first: line "+((r.errors||[])[0]||{}).line);
  }
  io.paint();
  return r;
 }).catch(function(e){S.busy=false;wrgFail(io,e)});
}
function wrgAfterWrite(S,io,r,verb){
 S.busy=false;
 if(!r.ok){io.status("err",r.error||r.message||verb+" refused");io.paint();return r}
 S.passed=null;S.diff="";
 io.status("ok",verb+" · backup "+r.backup);
 return wrgLoad(S,io,true).then(function(){return r});
}
function wrgSave(S,io){
 var why=wrgCanSave(S);
 if(why!==true){io.status("err","cannot save: "+why);io.paint();return Promise.resolve(null)}
 S.busy=true;io.status("pending","saving…");io.paint();
 return io.post("/cockpit/registry/save",{yaml:S.text,baseHash:S.hash}).then(function(r){return wrgAfterWrite(S,io,r,"saved")}).catch(function(e){S.busy=false;wrgFail(io,e)});
}
/** Restore: the first call arms the row, a second within WRG_ARM_MS posts (the server validates and backs up what it replaces). */
function wrgRestore(S,io,name,now){
 if(S.arm!==name||now-S.armAt>WRG_ARM_MS){S.arm=name;S.armAt=now;io.paint();return Promise.resolve(null)}
 S.arm=null;S.busy=true;io.status("pending","restoring…");io.paint();
 return io.post("/cockpit/registry/restore",{name:name,baseHash:S.hash}).then(function(r){return wrgAfterWrite(S,io,r,"restored")}).catch(function(e){S.busy=false;wrgFail(io,e)});
}
/** The local_tiers entry names in the text (the first one prefills the duplicate form). */
function wrgTierNames(text){
 var out=[],inT=false,lines=String(text).split("\n"),i,m;
 for(i=0;i<lines.length;i++){
  if(/^local_tiers\s*:/.test(lines[i])){inT=true;continue}
  if(/^\S/.test(lines[i])&&!/^#/.test(lines[i])){inT=false;continue}
  m=inT&&/^  ([A-Za-z0-9_.-]+)\s*:/.exec(lines[i]);
  if(m)out.push(m[1]);
 }
 return out;
}
/** Duplicate: the server inserts the copy into the text (not saved); the result is validated at once. A clash is refused with the server's text. */
function wrgDuplicate(S,io,f){
 var body={yaml:S.text,name:f.name};
 if(f.newName)body.newName=f.newName;
 if(f.port!==""&&f.port!=null&&!isNaN(Number(f.port)))body.port=Number(f.port);
 S.busy=true;io.status("pending","duplicating…");io.paint();
 return io.post("/cockpit/registry/duplicate",body).then(function(r){
  S.busy=false;
  if(!r.ok){io.status("err",r.error||r.message||"duplicate refused");io.paint();return r}
  S.text=r.yaml;S.passed=null;S.dup=false;
  io.paint(true);
  return wrgValidate(S,io).then(function(v){
   if(v&&v.ok)io.status("ok","duplicated as "+r.name+" on port "+r.port+" · not saved");
   return r;
  });
 }).catch(function(e){S.busy=false;wrgFail(io,e)});
}
function wrgBackupsHtml(S){
 if(!S.backups.length)return'<span class="dim">no backups yet</span>';
 return S.backups.map(function(b){
  var armed=S.arm===b.name;
  return'<div class="wrg-b" style="display:flex;gap:8px;align-items:center;padding:2px 0"><span class="mid" title="'+esc(b.name)+'">'+esc(b.name.replace(/^workers\.yaml\./,"").replace(/\.bak$/,""))+'</span><span class="dim">'+Math.round(b.size/102.4)/10+' kB · '+esc(b.summary)+'</span><button type="button" class="cbtn wrg-rs" data-n="'+esc(b.name)+'"'+(S.busy?' disabled title="working"':"")+' style="margin-left:auto">'+(armed?"confirm restore":"restore")+"</button></div>";
 }).join("");
}
var wrgIo=null;
function wrgGet(u){return WIN_HOST.fetch(u,{method:"GET",headers:{}}).then(function(r){return r.text().then(function(t){return JSON.parse(t)})})}
function wrgPost(u,b){return WIN_HOST.fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.text().then(function(t){var j;try{j=JSON.parse(t)}catch(e){throw new Error("HTTP "+r.status+" not JSON")}return j})})}
function wrgTa(){var e=Win.el(WRG_ID);return e?e.querySelector("textarea.wrg-ta"):null}
/** Repaint both cards from WRG: the textarea only when its text was replaced (setText), the diff slot, the form, the backups, the header buttons. */
function wrgPaint(setText){
 var ta=wrgTa(),c=Win.ctx(WRG_ID),b=Win.ctx(WRG_BK);
 if(ta&&setText)ta.value=WRG.text;
 if(c){c.text("diff",WRG.diff);c.attr("diff","hidden",WRG.diff?null:"");wrgDupPaint(c)}
 if(b)b.html("l",wrgBackupsHtml(WRG));
 Win.update("registry",WRG);
}
function wrgDupPaint(c){
 var f=Win.el(WRG_ID).querySelector('[data-k="dup"]');
 if(!f)return;
 if(!WRG.dup){if(f.firstChild)f.innerHTML="";f.hidden=true;return}
 if(f.firstChild)return;
 f.hidden=false;
 var names=wrgTierNames(WRG.text);
 f.innerHTML='<input class="wrg-dn" aria-label="entry to copy" placeholder="entry" value="'+esc(names[0]||"")+'" size="14"> <input class="wrg-dm" aria-label="new name" placeholder="new name (default: name-2)" size="22"> <input class="wrg-dp" aria-label="port" placeholder="port (default: next free)" size="20"> <button type="button" class="cbtn wrg-go">duplicate</button> <button type="button" class="cbtn wrg-no">cancel</button>';
}
function wrgIoMake(){
 return{get:wrgGet,post:wrgPost,status:function(k,t){var c=Win.ctx(WRG_ID);if(c)c.status(k,t)},paint:wrgPaint};
}
Win.registerType("editor",{minW:360,minH:220,defaultH:360,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wrg" style="display:flex;flex-direction:column;height:100%;gap:4px;padding:4px"><div class="wrg-f" data-k="dup" hidden style="flex:none"></div><textarea class="wrg-ta" spellcheck="false" aria-label="workers.yaml registry text" style="flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;font:12px/1.4 ui-monospace,Menlo,monospace;resize:none;tab-size:2"></textarea><pre class="wrg-diff" data-k="diff" hidden style="flex:0 1 35%;margin:0;overflow:auto;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre"></pre></div>';
  var ta=ctx.body.querySelector("textarea");
  ta.value=WRG.text;
  ta.addEventListener("input",function(){WRG.text=ta.value;Win.update("registry",WRG)});
  ctx.body.addEventListener("click",function(ev){
   var t=ev.target,io=wrgIo;
   if(!t||!t.classList||!io)return;
   if(t.classList.contains("wrg-no")){WRG.dup=false;wrgPaint()}
   else if(t.classList.contains("wrg-go")){
    var q=function(c){return ctx.body.querySelector(c).value.trim()};
    wrgDuplicate(WRG,io,{name:q(".wrg-dn"),newName:q(".wrg-dm"),port:q(".wrg-dp")});
   }
  });
 },
 update:function(ctx,S){
  var ta=ctx.body.querySelector("textarea");
  if(ta&&ta.value!==S.text)ta.value=S.text;
 }});
/** The backups card paints from WRG itself, so a card minimized at load fills the moment it mounts (restore). */
Win.registerType("backups",{minW:200,minH:60,defaultH:120,
 mount:function(ctx){ctx.body.innerHTML='<div class="wr" data-k="l"></div>';ctx.html("l",wrgBackupsHtml(WRG))},
 update:function(ctx,S){ctx.html("l",wrgBackupsHtml(S))}});
function wrgActs(){
 function io(){return wrgIo||(wrgIo=wrgIoMake())}
 return[
  {id:"validate",label:"Validate",title:"check this text against the registry rules",enabled:function(){return wrgCanCheck(WRG)},run:function(){wrgValidate(WRG,io())}},
  {id:"diff",label:"Diff",title:"show the changes against the file on disk",enabled:function(){return wrgCanCheck(WRG)},run:function(){wrgValidate(WRG,io())}},
  {id:"save",label:"Save",title:"write the text to workers.yaml (a backup of the old file is kept)",enabled:function(){return wrgCanSave(WRG)},run:function(){wrgSave(WRG,io())}},
  {id:"duplicate",label:"Duplicate",title:"copy a local_tiers entry under a new name and port into the text",enabled:function(){return wrgCanCheck(WRG)},run:function(){WRG.dup=!WRG.dup;wrgPaint()}}
 ];
}
function wrgBackupClick(ev){
 var t=ev.target;
 if(!t||!t.classList||!t.classList.contains("wrg-rs"))return;
 wrgRestore(WRG,wrgIo||(wrgIo=wrgIoMake()),t.getAttribute("data-n"),Date.now());
}
/** Start the registry cards: the click handler on the backups card, then the first load. */
function wrgStart(){
 wrgIo=wrgIoMake();
 var b=Win.el(WRG_BK);
 if(b)b.addEventListener("click",wrgBackupClick);
 return wrgLoad(WRG,wrgIo,false);
}
function registryDefaults(){
 var cards=[{id:"settings",type:"group",title:"Settings",info:WRG_INFO},
  {id:WRG_ID,type:"editor",title:"Model registry (workers.yaml)",feeds:["registry"],actions:wrgActs()},
  {id:WRG_BK,type:"backups",title:"Registry backups",feeds:["registry"]}];
 return{tree:WinT.leaf("settings"),kids:{settings:WinT.split("c",[WinT.leaf(WRG_ID),WinT.leaf(WRG_BK)],[0.72,0.28])},stDefaults:{},cards:cards};
}
`;
