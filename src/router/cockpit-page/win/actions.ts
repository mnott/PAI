/** cockpit-page/win — the action registry and runner (spec 5.2). Pure ES5 inside a string.
 *  Replaces postAction/wireAct/reapplyActs/actMsg/armBtn. The page runtime supplies the host:
 *  { fetch, setStatus(id,kind,text), setBusy(id,on,el), clearStatus(cardId), refresh(feeds), announce(text) }.
 *  WIN_VERBS is the one production table: the defAction registrations below and the page both
 *  use it, and the field-contract test iterates it — never a hand-written copy. */

/** One registered action. fields are the body keys build may set; the field-contract test
 *  posts exactly what build produces and requires the real handler to accept it. */
export type WinActionDef = {
  fields: string[];
  /** the POST url; absent = /cockpit/action. Queue verbs carry their /cockpit/queue/<verb> route. */
  route?: string;
  build: (args: { [k: string]: unknown }) => { action: string; target?: string; value?: string; count?: number; models?: string[]; route?: string; body?: { [k: string]: unknown } };
  confirm?: string;
  doneRefresh?: string[];
};
export type WinActionRegistry = { [verb: string]: WinActionDef };
export type WinActionHost = {
  fetch: (url: string, opts: { method: string; headers: { [k: string]: string }; body: string }) => Promise<{ status: number; text: () => Promise<string> }>;
  setStatus: (cardId: string, kind: string, text: string) => void;
  /** disables/enables the INVOKING control (el), not the whole card (spec 5.2). */
  setBusy: (cardId: string, on: boolean, el?: unknown) => void;
  /** clears the card's status line (the err path: a click on the status text calls it). */
  clearStatus?: (cardId: string) => void;
  refresh: (feeds: string[]) => void;
  announce?: (text: string) => void;
};
/** runAction's options: pollMs shortens the job-poll wait below the JOB_POLL policy (tests only). */
export type WinActionOpts = { pollMs?: number };
export type WinActionResult = { ok: boolean; message: string };

/** Action registry, runner, confirm button and status flow, per spec 5.2. Testable with new Function.
 *  - defAction(verb, def) registers one action; runAction(cardId, verb, args, el, host) runs it.
 *  - runAction: status "pending" + the invoking control disabled; POST /cockpit/action (or the
 *    def's route); ok -> status "ok" for STATUS_OK_MS then refresh doneRefresh feeds;
 *    ok:false -> status "err" with the server's message, kept until the next action on the
 *    card or clearStatus(cardId)/a click on the status text; HTTP error, non-JSON, network
 *    failure or a body without ok -> status "err" "no answer: <detail>" — never silent. A
 *    non-200 whose body is JSON {ok:false,message} shows that message instead.
 *  - a second runAction while one is pending for the same control (el) is refused with status
 *    "already running".
 *  - a reply with jobId keeps the control busy and polls /cockpit/job?id= under the JOB_*
 *    policy (host.fetch); each poll updates the pending status; done/failed finish ok/err and
 *    refresh; a job that never ends finishes err "no result after N s".
 *  - confirm: armConfirm(el, def) arms on the first click (the button's own label shows the
 *    confirm text; the state lives on the element, so polls cannot lose it), a second click
 *    within WIN_CONFIRM_MS runs; winClick(el, cardId, verb, args, host) is the click entry. */
export const WIN_ACTIONS_JS = String.raw`var STATUS_OK_MS=8000;
var WIN_CONFIRM_MS=4000;
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
function winBusy(host,cardId,on,el){if(host&&host.setBusy)host.setBusy(cardId,!!on,el)}
function winAnnounce(host,text){if(host&&host.announce)host.announce(text)}
/** The one status timer per card: ok clears itself after STATUS_OK_MS; err/pending stay. */
var okTimer={};
function clearOk(cardId){if(okTimer[cardId]!=null){clearTimeout(okTimer[cardId]);okTimer[cardId]=null}}
function finishOk(host,cardId,def,message){
 clearOk(cardId);
 winStatus(host,cardId,"ok",message);
 winAnnounce(host,message);
 okTimer[cardId]=setTimeout(function(){okTimer[cardId]=null;winStatus(host,cardId,"","")},STATUS_OK_MS);
 if(def&&def.doneRefresh&&host&&host.refresh)host.refresh(def.doneRefresh);
}
function finishErr(host,cardId,message){
 clearOk(cardId);
 winStatus(host,cardId,"err",message);
 winAnnounce(host,message);
}
/** Clears a card's status line: the err path ends here (a click on the status text calls it). */
function clearStatus(host,cardId){
 clearOk(cardId);
 if(host&&host.clearStatus)host.clearStatus(cardId);
 else winStatus(host,cardId,"","");
}
/** One POST; resolves {ok,message} for every shape of answer, never throws. A non-200 whose
 *  body parses as JSON {ok:false,message} shows that message; only a non-JSON body is
 *  "no answer: HTTP n". */
function winPost(host,url,bodyObj){
 var detail="";
 return host.fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(bodyObj),cache:"no-store"})
  .then(function(r){
   if(!r){detail="HTTP ?";return null}
   return r.text().catch(function(){return""}).then(function(t){
    var j=null;try{j=JSON.parse(t)}catch(e){j=null}
    if(r.status===200){
     if(!j||typeof j!=="object")detail="not JSON";
     else if(typeof j.ok!=="boolean")detail="body without ok";
     else return{ok:j.ok,message:j.message||"",jobId:j.jobId};
     return{ok:false,message:"no answer: "+detail};
    }
    if(j&&typeof j==="object"&&j.ok===false&&typeof j.message==="string")return{ok:false,message:j.message};
    detail="HTTP "+r.status;
    if(j&&typeof j==="object"&&typeof j.error==="string")detail+=": "+j.error;
    return{ok:false,message:"no answer: "+detail};
   });
  })
  .catch(function(e){return{ok:false,message:"no answer: "+(detail||(e&&e.message)||"network failure")}});
}
/** Polls /cockpit/job?id= under the JOB_* policy. Resolves the last job seen, or null when
 *  every poll failed; a job that never ends resolves null after JOB_TRIES*JOB_POLL ms. */
/** Polls a job to its end, but resolves early when the job file is gone: a 404 or a
 *  {"error":"no such job"} body twice in a row means the job is over and unreadable —
 *  do not sit out the whole JOB_TRIES budget. pollMs is the wait between polls; the
 *  default is the JOB_POLL policy (a test may pass a shorter one). A job that never
 *  ends resolves null after JOB_TRIES polls -> jobResult "no result after N s". */
function winPollJobEnd(host,jobId,onTick,pollMs){
 var tries=0,gone=0,wait=pollMs==null?JOB_POLL:pollMs;
 function step(){
  return host.fetch("/cockpit/job?id="+encodeURIComponent(jobId),{method:"GET",headers:{},cache:"no-store"})
   .then(function(r){
    if(!r||r.status!==200)return"gone";
    return r.text().catch(function(){return""}).then(function(t){
     var j=null;try{j=JSON.parse(t)}catch(e){j=null}
     if(!j||typeof j!=="object"||j.id===undefined)return"gone"; // {"error":"no such job"}
     if(j.state==="done"||j.state==="failed")return j;
     if(onTick)onTick(j);
     return null;
    });
   })
   .catch(function(){return null})
   .then(function(x){
    if(x&&x!=="gone")return x; // a terminal job
    if(x==="gone"){gone++;if(gone>=2)return"gone"}else gone=0;
    tries++;
    if(tries>=JOB_TRIES)return null;
    // one timer per wait: a timer created inside a timer callback is never reached by
    // advanceTimersByTime (vitest snapshots the queue per call), so the chain would hang
    return new Promise(function(res){setTimeout(function(){res(step())},wait)});
   });
 }
 return new Promise(function(res){setTimeout(function(){res(step())},wait)});
}
/** The job's outcome as the runner's result: done -> ok, failed -> err, no result -> err. */
function jobResult(job){
 if(job&&job.state==="done")return{ok:true,message:job.message||"done"};
 if(job&&job.state==="failed")return{ok:false,message:job.message||"failed"};
 return{ok:false,message:"no result after "+Math.round(JOB_TRIES*JOB_POLL/1000)+" s"};
}
var pendingEl={}; // cardId -> the control with a run in flight
/** opts.pollMs shortens the job-poll wait below the JOB_POLL policy (tests only). */
function runAction(cardId,verb,args,el,host,opts){
 var def=actionDef(verb);
 if(!def)return Promise.resolve({ok:false,message:"unknown action "+verb});
 if(el&&pendingEl[cardId]===el){
  winStatus(host,cardId,"err","already running");
  return Promise.resolve({ok:false,message:"already running"});
 }
 clearOk(cardId);
 if(el)pendingEl[cardId]=el;
 winBusy(host,cardId,true,el);
 winStatus(host,cardId,"pending",verb+" ...");
 var url=def.route?def.route:"/cockpit/action";
 return winPost(host,url,winBody(def,args)).then(function(r){
  if(r.ok&&r.jobId){
   // an accepted job stays pending/busy; the runner polls /cockpit/job itself (JOB_* policy)
   winStatus(host,cardId,"pending",(r.message||verb)+" ...");
   return winPollJobEnd(host,r.jobId,function(j){
    winStatus(host,cardId,"pending",(j.message||verb)+" ..."+(j.elapsedSec!=null?" "+j.elapsedSec+" s":"")+(j.tail?" · "+j.tail:""));
   },opts&&opts.pollMs).then(function(j){
    if(el&&pendingEl[cardId]===el)delete pendingEl[cardId];
    winBusy(host,cardId,false,el);
    var res=j==="gone"?{ok:false,message:"no such job"}:jobResult(j);
    if(res.ok)finishOk(host,cardId,def,res.message);else finishErr(host,cardId,res.message);
    return res;
   });
  }
  if(el&&pendingEl[cardId]===el)delete pendingEl[cardId];
  winBusy(host,cardId,false,el);
  if(r.ok)finishOk(host,cardId,def,r.message);
  else finishErr(host,cardId,r.message);
  return r;
 });
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
 },WIN_CONFIRM_MS);
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
/** The one production verb table: defAction registrations and the page use this, and the
 *  field-contract test iterates it. route is the POST url when it is not /cockpit/action. */
var WIN_VERBS={
 "local.start":{fields:["target"],build:function(a){return{action:"local.start",target:a.target}}},
 "local.stop":{fields:["target","value"],build:function(a){return{action:"local.stop",target:a.target,value:a.value}},confirm:"stop - click again"},
 "local.scale":{fields:["target","count"],build:function(a){return{action:"local.scale",target:a.target,count:a.count}}},
 "local.off":{fields:[],build:function(){return{action:"local.off"}},confirm:"stop every local - click again"},
 "runtime":{fields:["target","value"],build:function(a){return{action:"runtime",target:a.target,value:a.value}}},
 "model.label":{fields:["target","value"],build:function(a){return{action:"model.label",target:a.target,value:a.value}}},
 "route.set":{fields:["target","models"],build:function(a){return{action:"route.set",target:a.target,models:a.models}}},
 "endpoint.enable":{fields:["target","value"],build:function(a){return{action:"endpoint.enable",target:a.target,value:a.value}}},
 "memory.embed":{fields:[],build:function(){return{action:"memory.embed"}},doneRefresh:["memory"]},
 "memory.index":{fields:[],build:function(){return{action:"memory.index"}},doneRefresh:["memory"]},
 "memory.stop":{fields:[],build:function(){return{action:"memory.stop"}},doneRefresh:["memory"]},
 "queue.next":{fields:["id"],route:"/cockpit/queue/next",build:function(a){return{action:"queue.next",body:{id:a.id}}},doneRefresh:["queue"]},
 "queue.up":{fields:["id"],route:"/cockpit/queue/up",build:function(a){return{action:"queue.up",body:{id:a.id}}},doneRefresh:["queue"]},
 "queue.front":{fields:["id"],route:"/cockpit/queue/front",build:function(a){return{action:"queue.front",body:{id:a.id}}},doneRefresh:["queue"]},
 "queue.move":{fields:["id","position"],route:"/cockpit/queue/move",build:function(a){return{action:"queue.move",body:{id:a.id,position:a.position}}},doneRefresh:["queue"]}
};
for(var v in WIN_VERBS)defAction(v,WIN_VERBS[v]);
`;
