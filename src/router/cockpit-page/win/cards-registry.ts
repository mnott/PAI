/** cockpit-page/win — B8b-client `settings`: the registry editor on the win runtime (spec 7/B8b).
 *  Page-scope ES5 (after scriptCore: esc in scope), needs `Win`, `WinT` and `WIN_HOST` ({fetch}). Group `settings`:
 *  the `editor` card `settings.registry-edit` (a monospace textarea holding the whole workers.yaml text from
 *  GET /cockpit/registry; header actions Validate, Save, Duplicate) and the `list` card `settings.registry-backups`
 *  (GET /cockpit/registry/backups, newest first; per row diff against the file, name, Restore and delete, each destructive one with a two-click confirm). Save stays disabled until Validate has
 *  passed on exactly the text in the editor; validate/save/restore/duplicate results show in the editor card's status slot,
 *  the error list or the diff in its `diff` slot. The routes are the POST-only ones of src/router/cockpit-registry.ts.
 *  The state `WRG` and the logic take an io {get, post, status, paint} so a test drives them with a fake fetch; the
 *  card wiring below only reads/writes the textarea. Names are prefixed wrg*. */

export const WIN_REGISTRY_JS = String.raw`var WRG_ID="settings.registry-edit",WRG_BK="settings.registry-backups",WRG_ARM_MS=4000;
var WRG_INFO="The model registry (local_tiers and providers of workers.yaml). Validate checks the text; Save writes it atomically and keeps a timestamped backup; Save is only enabled after Validate passed on exactly this text.";
var WRG={hash:"",saved:"",text:"",passed:null,backups:[],diff:"",arm:null,delArm:null,editing:null,dup:false,busy:false,loaded:false};
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
  if(!r||typeof r.yaml!=="string"){S.loaded=false;io.status("err","registry not available"+(r&&r.error?": "+r.error:""));io.paint();return wrgBackups(S,io)}
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
 if(io.refresh)io.refresh(["models","limits"]);
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
/** Diff of one backup against the current file, shown in the editor's diff slot. */
function wrgBackupDiff(S,io,name){
 io.status("pending","diffing "+name+"…");
 return io.post("/cockpit/registry/backup-diff",{name:name}).then(function(r){
  if(!r.ok){io.status("err",r.error||"diff refused");io.paint();return r}
  S.diff=(r.diff||[]).join("\n");
  io.status("ok","diff of "+name+" · "+((r.diff||[]).length?(r.diff||[]).length+" changed lines (- now, + in the backup)":"identical to the file"));
  io.paint();
  return r;
 }).catch(function(e){wrgFail(io,e)});
}
/** Delete a backup: the first call arms the row, a second within WRG_ARM_MS posts. */
function wrgDelete(S,io,name,now){
 if(S.delArm!==name||now-S.delAt>WRG_ARM_MS){S.delArm=name;S.delAt=now;S.arm=null;io.paint();return Promise.resolve(null)}
 S.delArm=null;
 return io.post("/cockpit/registry/backup-delete",{name:name}).then(function(r){
  if(!r.ok){io.status("err",r.error||"delete refused");io.paint();return r}
  io.status("ok","deleted "+name);
  return wrgBackups(S,io).then(function(){return r});
 }).catch(function(e){wrgFail(io,e)});
}
/** Name a backup (empty clears the name). */
function wrgLabel(S,io,name,label){
 S.editing=null;
 return io.post("/cockpit/registry/backup-label",{name:name,label:label}).then(function(r){
  if(!r.ok){io.status("err",r.error||"rename refused");io.paint();return r}
  return wrgBackups(S,io).then(function(){return r});
 }).catch(function(e){wrgFail(io,e)});
}
/** The local_tiers entry names in the text (the first one prefills the duplicate form). */
/** YAML highlight: one line to HTML spans (classes wrg-c comment, wrg-k key, wrg-s string, wrg-n number, wrg-b bool/null, wrg-d list dash, wrg-a anchor/alias). Pure, per line, no state across lines. */
function wrgHlLine(l){
 var o="",i=0,m=/^(\s*)((?:-(?:\s+|$))*)/.exec(l);
 o+=esc(m[1]);
 if(m[2])o+=esc(m[2]).replace(/-/g,'<span class="wrg-d">-</span>');
 i=m[0].length;
 var k=/^("[^"]*"|'[^']*'|[^\s#:'"\[\]{},&*][^#:]*?)(?=:(?:\s|$))/.exec(l.slice(i));
 if(k){o+='<span class="wrg-k">'+esc(k[1])+'</span>:';i+=k[1].length+1}
 var n=l.length,w;
 while(i<n){
  var c=l.charAt(i);
  if(c==="#"&&(i===0||/\s/.test(l.charAt(i-1)))){o+='<span class="wrg-c">'+esc(l.slice(i))+'</span>';break}
  if(c==='"'||c==="'"){
   var j=i+1;
   while(j<n){var d=l.charAt(j);if(c==='"'&&d==="\\"){j+=2;continue}if(d===c){if(c==="'"&&l.charAt(j+1)==="'"){j+=2;continue}break}j++}
   j=Math.min(j+1,n);o+='<span class="wrg-s">'+esc(l.slice(i,j))+'</span>';i=j;continue;
  }
  if(/\s/.test(c)){var e=i;while(e<n&&/\s/.test(l.charAt(e)))e++;o+=esc(l.slice(i,e));i=e;continue}
  var q=i;
  while(q<n&&!/[\s"']/.test(l.charAt(q)))q++;
  w=l.slice(i,q);
  var p=/^([\[{]*)(.*?)([\],}]*)$/.exec(w),b=p[2],cls="";
  if(/^[&*][\w-]+$/.test(b))cls="a";
  else if(/^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+)$/.test(b))cls="n";
  else if(/^(?:true|false|null|~)$/.test(b))cls="b";
  o+=esc(p[1])+(cls?'<span class="wrg-'+cls+'">'+esc(b)+'</span>':esc(b))+esc(p[3]);
  i=q;
 }
 return o;
}
/** Highlight a whole text: one output line per input line, plus a trailing newline so the layer is as tall as the textarea. */
function wrgHl(text){return text.split("\n").map(wrgHlLine).join("\n")+"\n"}
/** Folding. The model is the full text (WRG.text); the textarea shows a folded VIEW of it. Pure parts first. */
var WRG_FOLD_KEY="pai.cockpit.regfold";
/** Blocks of a YAML text, indent based: a meaningful (non-blank, non-comment) line whose next meaningful line is indented deeper opens a block that runs to the last deeper meaningful line (blank and comment lines inside belong to it). Returns [{start,end,ind,depth,path}] in line order; path = key chain joined by "/", list items as [n]. */
function wrgBlocks(text){
 var L=text.split("\n"),n=L.length,out=[],mean=[],ind=[],i,k,st=[],dn={};
 function ind0(l){var m=/^ */.exec(l);return m[0].length}
 for(i=0;i<n;i++){var t=L[i].trim();if(t!==""&&t.charAt(0)!=="#"){mean.push(i);ind[i]=ind0(L[i])}}
 for(k=0;k<mean.length;k++){
  i=mean[k];
  while(st.length&&st[st.length-1].ind>=ind[i])st.pop();
  var t2=L[i].trim(),key,par=st.length?st[st.length-1].path:"";
  if(/^-(\s|$)/.test(t2)){var dk=par+"@"+ind[i];dn[dk]=(dn[dk]===undefined?-1:dn[dk])+1;key="["+dn[dk]+"]"}
  else{var c=t2.indexOf(":");key=c>0?t2.slice(0,c):t2}
  var path=par?par+"/"+key:key;
  st.push({ind:ind[i],path:path});
  var nx=mean[k+1];
  if(nx!==undefined&&ind[nx]>ind[i]){
   var e=k+1;while(e+1<mean.length&&ind[mean[e+1]]>ind[i])e++;
   out.push({start:i,end:mean[e],ind:ind[i],depth:st.length,path:path});
  }
 }
 return out;
}
/** Folded view of text: paths = {path:1}. lines = view lines, map[i] = first model line of view line i, mk[i] = hidden line count when view line i is a fold marker (else 0). A block inside a folded block is covered by the outer fold. */
function wrgFoldView(text,paths){
 var L=text.split("\n"),bl=wrgBlocks(text),at={},i,lines=[],map=[],mk=[];
 for(i=0;i<bl.length;i++)if(paths[bl[i].path]&&!at[bl[i].start])at[bl[i].start]=bl[i];
 for(i=0;i<L.length;i++){
  lines.push(L[i]);map.push(i);mk.push(0);
  var b=at[i];
  if(b){
   var N=b.end-b.start;
   lines.push(new Array(b.ind+3).join(" ")+"⋯ "+N+" line"+(N===1?"":"s"));map.push(b.start+1);mk.push(N);
   i=b.end;
  }
 }
 return{lines:lines,map:map,mk:mk};
}
/** New model text after the textarea went from view V (wrgFoldView result) to newViewText. hit = view indexes of marker lines the edit touched (the model is then unchanged: caller unfolds those first). */
function wrgFoldEdit(modelText,V,newViewText){
 var M=modelText.split("\n"),nv=newViewText.split("\n"),ov=V.lines,p=0,s=0,i,hit=[],o=[];
 while(p<ov.length&&p<nv.length&&ov[p]===nv[p])p++;
 while(s<ov.length-p&&s<nv.length-p&&ov[ov.length-1-s]===nv[nv.length-1-s])s++;
 for(i=p;i<ov.length-s;i++)if(V.mk[i])hit.push(i);
 if(hit.length)return{text:modelText,hit:hit};
 function expand(a,b){for(var j=a;j<b;j++){var c=V.mk[j]||1;for(var q=0;q<c;q++)o.push(M[V.map[j]+q])}}
 expand(0,p);
 for(i=p;i<nv.length-s;i++)o.push(nv[i]);
 expand(ov.length-s,ov.length);
 return{text:o.join("\n"),hit:null};
}
function wrgFoldLoad(){try{var a=JSON.parse(localStorage.getItem(WRG_FOLD_KEY)||"[]"),o={};for(var i=0;i<a.length;i++)o[a[i]]=1;return o}catch(e){return{}}}
function wrgFoldSave(){try{localStorage.setItem(WRG_FOLD_KEY,JSON.stringify(Object.keys(WRGF.paths)))}catch(e){}}
var WRGF={paths:wrgFoldLoad(),V:null,text:null};
/** Toggle the block whose header is model line h; alt folds/unfolds all its siblings (same parent, same depth) to the same state. */
function wrgFoldToggle(text,h,all){
 var bl=wrgBlocks(text),b=null,i;
 for(i=0;i<bl.length;i++)if(bl[i].start===h){b=bl[i];break}
 if(!b)return;
 var on=!WRGF.paths[b.path],par=b.path.slice(0,b.path.length-b.path.split("/").pop().length);
 for(i=0;i<bl.length;i++){
  var x=bl[i];
  if(x===b||(all&&x.depth===b.depth&&x.path.slice(0,par.length)===par&&x.path.indexOf("/",par.length)<0)){if(on)WRGF.paths[x.path]=1;else delete WRGF.paths[x.path]}
 }
 wrgFoldSave();
}
function wrgFoldAll(text,on){
 WRGF.paths={};
 if(on){var bl=wrgBlocks(text);for(var i=0;i<bl.length;i++)if(bl[i].depth===1)WRGF.paths[bl[i].path]=1}
 wrgFoldSave();
}
/** Gutter HTML: one row per view line, model line number and a fold toggle on block headers. */
function wrgGutHtml(text,V){
 var bl=wrgBlocks(text),at={},i,o=[];
 for(i=0;i<bl.length;i++)at[bl[i].start]=bl[i];
 for(i=0;i<V.lines.length;i++){
  var b=V.mk[i]?null:at[V.map[i]],tg="";
  if(b)tg='<b class="wrg-tg" data-h="'+b.start+'" title="fold or unfold (alt: all siblings)">'+(V.mk[i+1]?"▸":"▾")+'</b>';
  o.push('<span class="wrg-gn">'+(V.map[i]+1)+'</span>'+(tg||'<b class="wrg-tg"> </b>'));
 }
 return o.join("\n")+"\n";
}
/** Repaint textarea (when its folded view changed), highlight layer and gutter from WRG.text. */
function wrgFoldRender(root){
 var ta=root.querySelector("textarea.wrg-ta"),pre=root.querySelector("pre.wrg-hl"),g=root.querySelector("pre.wrg-gut");
 if(!ta||!pre)return;
 var V=wrgFoldView(WRG.text,WRGF.paths),v=V.lines.join("\n");
 WRGF.V=V;WRGF.text=WRG.text;
 if(ta.value!==v){var a=ta.selectionStart,b=ta.selectionEnd;ta.value=v;try{ta.setSelectionRange(a,b)}catch(e){}}
 pre.innerHTML=V.lines.map(function(l,i){return V.mk[i]?'<span class="wrg-m">'+esc(l)+'</span>':wrgHlLine(l)}).join("\n")+"\n";
 if(g)g.innerHTML=wrgGutHtml(WRG.text,V);
 wrgHlSync(root);
}
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
 var dis=S.busy?' disabled title="working"':"";
 return S.backups.map(function(b){
  var armed=S.arm===b.name,delArmed=S.delArm===b.name,n=esc(b.name);
  var label=S.editing===b.name
   ?'<input class="wrg-bl" data-n="'+n+'" value="'+esc(b.label||"")+'" placeholder="name this backup" maxlength="80" size="22" aria-label="backup name">'
   :(b.label?'<b class="wrg-lb">'+esc(b.label)+"</b>":"");
  return'<div class="wrg-b" style="display:flex;gap:8px;align-items:center;padding:2px 0"><span class="mid" title="'+n+'">'+esc(b.name.replace(/^workers\.yaml\./,"").replace(/\.bak$/,""))+"</span>"+label+'<span class="dim">'+Math.round(b.size/102.4)/10+' kB · '+esc(b.summary)+'</span>'
   +'<span style="margin-left:auto;display:flex;gap:4px"><button type="button" class="cbtn wrg-bd" data-n="'+n+'" title="show the changes between the file now and this backup">diff</button>'
   +'<button type="button" class="cbtn wrg-bn" data-n="'+n+'" title="give this backup a name">name</button>'
   +'<button type="button" class="cbtn wrg-rs" data-n="'+n+'"'+dis+'>'+(armed?"confirm restore":"restore")+"</button>"
   +'<button type="button" class="cbtn wrg-del" data-n="'+n+'" title="delete this backup">'+(delArmed?"confirm delete":"delete")+"</button></span></div>";
 }).join("");
}
var wrgIo=null;
function wrgGet(u){return WIN_HOST.fetch(u,{method:"GET",headers:{}}).then(function(r){return r.text().then(function(t){return JSON.parse(t)})})}
function wrgPost(u,b){return WIN_HOST.fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.text().then(function(t){var j;try{j=JSON.parse(t)}catch(e){throw new Error("HTTP "+r.status+" not JSON")}return j})})}
function wrgTa(){var e=Win.el(WRG_ID);return e?e.querySelector("textarea.wrg-ta"):null}
/** Repaint both cards from WRG: the textarea only when its text was replaced (setText), the diff slot, the form, the backups, the header buttons. */
function wrgPaint(setText){
 var ta=wrgTa(),c=Win.ctx(WRG_ID),b=Win.ctx(WRG_BK);
 if(ta&&setText)wrgFoldRender(Win.el(WRG_ID));
 if(ta)ta.readOnly=!WRG.loaded;
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
/** Repaint the highlight layer from the textarea text and align its scroll. */
function wrgHlPaint(root){
 var ta=root.querySelector("textarea.wrg-ta"),pre=root.querySelector("pre.wrg-hl");
 if(ta&&pre)wrgFoldRender(root);
}
function wrgHlSync(root){
 var ta=root.querySelector("textarea.wrg-ta"),pre=root.querySelector("pre.wrg-hl"),g=root.querySelector("pre.wrg-gut");
 if(ta&&pre){pre.scrollTop=ta.scrollTop;pre.scrollLeft=ta.scrollLeft}
 if(ta&&g)g.scrollTop=ta.scrollTop;
}
function wrgIoMake(){
 return{get:wrgGet,post:wrgPost,refresh:function(f){if(WIN_HOST.refresh)WIN_HOST.refresh(f)},status:function(k,t){var c=Win.ctx(WRG_ID);if(c)c.status(k,t)},paint:wrgPaint};
}
Win.registerType("editor",{minW:360,minH:220,defaultH:360,fixed:1,
 mount:function(ctx){
  ctx.body.innerHTML='<div class="wrg" style="display:flex;flex-direction:column;height:100%;gap:4px;padding:4px"><div class="wrg-f" data-k="dup" hidden style="flex:none"></div><div class="wrg-ft" style="flex:none;display:flex;gap:4px;justify-content:flex-end"><button type="button" class="cbtn wrg-fa" title="fold every top-level section">fold all</button><button type="button" class="cbtn wrg-ua" title="unfold every section">unfold all</button></div><div class="wrg-wrap"><pre class="wrg-gut" aria-hidden="false"></pre><pre class="wrg-hl" aria-hidden="true"></pre><textarea class="wrg-ta" wrap="off" spellcheck="false" title="workers.yaml: local_tiers and providers" aria-label="workers.yaml: local_tiers and providers"></textarea></div><pre class="wrg-diff" data-k="diff" hidden style="flex:0 1 35%;margin:0;overflow:auto;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre"></pre></div>';
  var ta=ctx.body.querySelector("textarea");
  ta.value=WRG.text;ta.readOnly=!WRG.loaded;wrgHlPaint(ctx.body);
  function unfoldAt(V,hit){
   for(var i=0;i<hit.length;i++){var h=V.map[hit[i]]-1,bl=wrgBlocks(WRG.text);for(var j=0;j<bl.length;j++)if(bl[j].start===h)delete WRGF.paths[bl[j].path]}
   wrgFoldSave();ta.value=V.lines.join("\n");wrgFoldRender(ctx.body);
  }
  ta.addEventListener("input",function(){
   var V=WRGF.V,r=V?wrgFoldEdit(WRG.text,V,ta.value):{text:ta.value,hit:null};
   if(r.hit){unfoldAt(V,r.hit);return}
   WRG.text=r.text;wrgFoldRender(ctx.body);Win.update("registry",WRG);
  });
  ta.addEventListener("keydown",function(ev){
   var V=WRGF.V;if(!V||ev.ctrlKey||ev.metaKey||/^(Arrow|Page|Home|End|Shift|Alt|Control|Meta|Tab|Escape)/.test(ev.key))return;
   var a=ta.value.slice(0,ta.selectionStart).split("\n").length-1,b=ta.value.slice(0,ta.selectionEnd).split("\n").length-1,hit=[];
   for(var i=a;i<=b;i++)if(V.mk[i])hit.push(i);
   if(hit.length){ev.preventDefault();unfoldAt(V,hit)}
  });
  ta.addEventListener("scroll",function(){wrgHlSync(ctx.body)});
  ctx.body.addEventListener("click",function(ev){
   var t=ev.target,io=wrgIo;
   if(!t||!t.classList||(!io&&!/wrg-(tg|fa|ua)/.test(t.className)))return;
   if(t.classList.contains("wrg-fa")||t.classList.contains("wrg-ua")){wrgFoldAll(WRG.text,t.classList.contains("wrg-fa"));wrgFoldRender(ctx.body)}
   else if(t.classList.contains("wrg-tg")&&t.hasAttribute("data-h")){wrgFoldToggle(WRG.text,+t.getAttribute("data-h"),ev.altKey);wrgFoldRender(ctx.body)}
   else if(t.classList.contains("wrg-no")){WRG.dup=false;wrgPaint()}
   else if(t.classList.contains("wrg-go")){
    var q=function(c){return ctx.body.querySelector(c).value.trim()};
    wrgDuplicate(WRG,io,{name:q(".wrg-dn"),newName:q(".wrg-dm"),port:q(".wrg-dp")});
   }
  });
 },
 update:function(ctx,S){
  var ta=ctx.body.querySelector("textarea");
  if(ta&&WRGF.text!==S.text)wrgFoldRender(ctx.body);
  if(ta)ta.readOnly=!S.loaded;
 }});
/** The backups card paints from WRG itself, so a card minimized at load fills the moment it mounts (restore). */
Win.registerType("backups",{minW:200,minH:60,defaultH:120,
 mount:function(ctx){ctx.body.innerHTML='<div class="wr" data-k="l"></div>';ctx.html("l",wrgBackupsHtml(WRG))},
 update:function(ctx,S){ctx.html("l",wrgBackupsHtml(S))}});
function wrgActs(){
 function io(){return wrgIo||(wrgIo=wrgIoMake())}
 return[
  {id:"validate",label:"Validate",title:"check this text against the registry rules",enabled:function(){return wrgCanCheck(WRG)},run:function(){wrgValidate(WRG,io())}},
  {id:"save",label:"Save",title:"write the text to workers.yaml (a backup of the old file is kept)",enabled:function(){return wrgCanSave(WRG)},run:function(){wrgSave(WRG,io())}},
  {id:"duplicate",label:"Duplicate",title:"copy a local_tiers entry under a new name and port into the text",enabled:function(){return wrgCanCheck(WRG)},run:function(){WRG.dup=!WRG.dup;wrgPaint()}}
 ];
}
function wrgBackupClick(ev){
 var t=ev.target,io,n;
 if(!t||!t.classList)return;
 io=wrgIo||(wrgIo=wrgIoMake());n=t.getAttribute("data-n");
 if(t.classList.contains("wrg-rs"))wrgRestore(WRG,io,n,Date.now());
 else if(t.classList.contains("wrg-del"))wrgDelete(WRG,io,n,Date.now());
 else if(t.classList.contains("wrg-bd"))wrgBackupDiff(WRG,io,n);
 else if(t.classList.contains("wrg-bn")){WRG.editing=n;wrgPaint();var i=Win.el(WRG_BK).querySelector(".wrg-bl");if(i)i.focus()}
}
function wrgBackupKey(ev){
 var t=ev.target;
 if(!t||!t.classList||!t.classList.contains("wrg-bl"))return;
 if(ev.key==="Enter")wrgLabel(WRG,wrgIo||(wrgIo=wrgIoMake()),t.getAttribute("data-n"),t.value);
 else if(ev.key==="Escape"){WRG.editing=null;wrgPaint()}
}
/** Start the registry cards: the click handler on the backups card, then the first load. */
function wrgStart(){
 wrgIo=wrgIoMake();
 var b=Win.el(WRG_BK);
 if(b){b.addEventListener("click",wrgBackupClick);b.addEventListener("keydown",wrgBackupKey)}
 return wrgLoad(WRG,wrgIo,false);
}
function registryDefaults(){
 var cards=[{id:"settings",type:"group",title:"Settings",info:WRG_INFO},
  {id:WRG_ID,type:"editor",title:"Model registry (workers.yaml)",feeds:["registry"],actions:wrgActs()},
  {id:WRG_BK,type:"backups",title:"Registry backups",feeds:["registry"]}];
 return{tree:WinT.leaf("settings"),kids:{settings:WinT.split("c",[WinT.leaf(WRG_ID),WinT.leaf(WRG_BK)],[0.72,0.28])},stDefaults:{},cards:cards};
}
`;
