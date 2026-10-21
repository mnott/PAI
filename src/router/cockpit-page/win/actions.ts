/** cockpit-page/win — the action registry and runner (spec 5.2). Pure ES5 inside a string.
 *  Replaces postAction/wireAct/reapplyActs/actMsg/armBtn. The page runtime supplies the host:
 *  { fetch, setStatus(id,kind,text), setBusy(id,on), refresh(feeds), watchJob(id), announce(text) }. */

/** One registered action. fields are the body keys build may set; the field-contract test
 *  posts exactly what build produces and requires the real handler to accept it. */
export type WinActionDef = {
  fields: string[];
  build: (args: { [k: string]: unknown }) => { action: string; target?: string; value?: string; count?: number; models?: string[]; route?: string; body?: { [k: string]: unknown } };
  confirm?: string;
  doneRefresh?: string[];
};
export type WinActionRegistry = { [verb: string]: WinActionDef };
export type WinActionHost = {
  fetch: (url: string, opts: { method: string; headers: { [k: string]: string }; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  setStatus: (cardId: string, kind: string, text: string) => void;
  setBusy: (cardId: string, on: boolean) => void;
  refresh: (feeds: string[]) => void;
  watchJob?: (id: string) => void;
  announce?: (text: string) => void;
};
export type WinActionResult = { ok: boolean; message: string };

/** Action registry, runner, confirm button and status flow, per spec 5.2. Testable with new Function.
 *  - defAction(verb, def) registers one action; runAction(cardId, verb, args, el) runs it.
 *  - runAction: status "pending" + the control disabled; POST /cockpit/action (or the def's
 *    queue route); ok -> status "ok" for STATUS_OK_MS then refresh doneRefresh feeds;
 *    ok:false -> status "err" with the server's message, kept until the next action on the
 *    card or a click on the status; HTTP error, non-JSON, network failure or a body without
 *    ok -> status "err" "no answer: <detail>" — never silent.
 *  - a reply with jobId keeps the card busy and watches the job (host.watchJob); the watcher
 *    calls winJobStatus(cardId, job) on every poll: running keeps pending, done/failed finish
 *    the status and refresh.
 *  - confirm: armConfirm(el, def) arms on the first click (the button's own label shows the
 *    confirm text; the state lives on the element, so polls cannot lose it), a second click
 *    within CONFIRM_MS runs; winClick(el, cardId, verb, args, run) is the click entry. */
export const WIN_ACTIONS_JS = String.raw`var STATUS_OK_MS=8000;
var CONFIRM_MS=4000;
var JOB_POLL=2000;
var JOB_TRIES=180;
var ACTIONS={};
function defAction(verb,def){ACTIONS[verb]=def;return def}
function actionDef(verb){return ACTIONS[verb]||null}
/** The body build produces, filtered of undefined: the field contract posts exactly this. */
function winBody(def,args){
 var b=def.build(args||{}),out={};
 // a route action (queue) posts its own body only; /cockpit/action takes the action fields
 if(b&&b.body){for(var k in b.body)if(b.body[k]!==undefined)out[k]=b.body[k];return out}
 if(b&&b.action!==undefined)out.action=b.action;
 if(b&&b.target!==undefined)out.target=b.target;
 if(b&&b.value!==undefined)out.value=b.value;
 if(b&&b.count!==undefined)out.count=b.count;
 if(b&&b.models!==undefined)out.models=b.models;
 return out;
}
function winStatus(host,cardId,kind,text){if(host&&host.setStatus)host.setStatus(cardId,kind,text||"")}
function winBusy(host,cardId,on){if(host&&host.setBusy)host.setBusy(cardId,!!on)}
function winAnnounce(host,text){if(host&&host.announce)host.announce(text)}
/** The one status timer per card: ok clears itself after STATUS_OK_MS; err/pending stay. */
var okTimer={};
function clearOk(cardId){if(okTimer[cardId]!=null){clearTimeout(okTimer[cardId]);okTimer[cardId]=null}}
function finishOk(host,cardId,def,message){
 clearOk(cardId);
 winStatus(host,cardId,"ok",message);
 winBusy(host,cardId,false);
 winAnnounce(host,message);
 okTimer[cardId]=setTimeout(function(){okTimer[cardId]=null;winStatus(host,cardId,"","")},STATUS_OK_MS);
 if(def&&def.doneRefresh&&host&&host.refresh)host.refresh(def.doneRefresh);
}
function finishErr(host,cardId,message){
 clearOk(cardId);
 winStatus(host,cardId,"err",message);
 winBusy(host,cardId,false);
 winAnnounce(host,message);
}
/** One POST; resolves {ok,message} for every shape of answer, never throws. */
function winPost(host,url,bodyObj){
 var detail="";
 return host.fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(bodyObj),cache:"no-store"})
  .then(function(r){
   if(!r||r.status!==200){detail="HTTP "+((r&&r.status)||"?");return null}
   return r.json().catch(function(){detail="not JSON";return null});
  })
  .then(function(j){
   if(!j||typeof j!=="object"||typeof j.ok!=="boolean")return{ok:false,message:"no answer: "+(detail||"body without ok")};
   return{ok:j.ok,message:j.message||"",jobId:j.jobId};
  })
  .catch(function(e){return{ok:false,message:"no answer: "+(detail||(e&&e.message)||"network failure")}});
}
function runAction(cardId,verb,args,el,host){
 var def=actionDef(verb);
 if(!def)return Promise.resolve({ok:false,message:"unknown action "+verb});
 clearOk(cardId);
 winBusy(host,cardId,true);
 winStatus(host,cardId,"pending",verb+" ...");
 var url=def.route?def.route:"/cockpit/action";
 return winPost(host,url,winBody(def,args)).then(function(r){
  if(r.ok&&r.jobId){
   // an accepted job stays pending/busy; the job watcher finishes it (winJobStatus)
   winStatus(host,cardId,"pending",(r.message||verb)+" ...");
   if(host&&host.watchJob)host.watchJob(r.jobId);
   return r;
  }
  if(r.ok)finishOk(host,cardId,def,r.message);
  else finishErr(host,cardId,r.message);
  return r;
 });
}
/** The job watcher's entry (the page polls /cockpit/job and calls this): running keeps the
 *  card pending with the job's message; done/failed finish it and refresh the action's feeds. */
function winJobStatus(cardId,verb,job,host){
 var def=actionDef(verb)||{doneRefresh:[]};
 if(!job)return;
 if(job.state==="done"||job.state==="failed"){
  winBusy(host,cardId,false);
  if(job.state==="done")finishOk(host,cardId,def,job.message||"done");
  else finishErr(host,cardId,job.message||"failed");
 }else{
  winBusy(host,cardId,true);
  winStatus(host,cardId,"pending",(job.message||verb)+" ..."+(job.elapsedSec!=null?" "+job.elapsedSec+" s":"")+(job.tail?" · "+job.tail:""));
 }
}
/** Confirm-on-second-click: the state lives on the button element, so a poll that re-renders
 *  nothing can lose it. First click arms (label becomes the confirm text), second runs. */
function armConfirm(el,cf){
 if(el.__cfTimer!=null)clearTimeout(el.__cfTimer);
 if(el.__label===undefined)el.__label=el.textContent;
 el.textContent=cf;el.__armed=1;
 el.__cfTimer=setTimeout(function(){
  el.__armed=0;el.__cfTimer=null;
  if(el.__label!==undefined)el.textContent=el.__label;
 },CONFIRM_MS);
}
function disarmConfirm(el){
 if(el.__cfTimer!=null){clearTimeout(el.__cfTimer);el.__cfTimer=null}
 el.__armed=0;
 if(el.__label!==undefined)el.textContent=el.__label;
}
/** The click entry for a control: arms a confirm action, otherwise runs it. */
function winClick(el,cardId,verb,args,host){
 var def=actionDef(verb);
 if(!def)return;
 if(def.confirm&&!el.__armed){armConfirm(el,def.confirm);return}
 disarmConfirm(el);
 runAction(cardId,verb,args,el,host);
}
`;
