const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
let calls=[],response;const sb={rpc:(name,args)=>{const call={name,args};calls.push(call);return {abortSignal(signal){call.signal=signal;return this;},then(resolve){return Promise.resolve(response).then(resolve);}};}};
const sync={exports:{},require:name=>name==='./staffNames'?{staffDisplayName:x=>x||''}:{getSupabase:()=>sb},Date,Map,Error};vm.runInNewContext(compile('packages/shared/src/inventorySync.ts'),sync);
const {mergeInventoryPage,cachedInventoryPage,rememberInventoryPage,fetchInventoryPage}=sync.exports;
const plain=x=>JSON.parse(JSON.stringify(x));
assert.deepEqual(plain(mergeInventoryPage([{id:'a',title:'old'},{id:'gone'}],{ids:['b','a'],rows:[{id:'b'},{id:'a',title:'new'}]})),[{id:'b'},{id:'a',title:'new'}]);
assert.deepEqual(plain(mergeInventoryPage([{id:'same'}],{unchanged:true,ids:[],rows:[]})),[{id:'same'}]);
assert.throws(()=>mergeInventoryPage([],{ids:['missing'],rows:[]}),/差分/);
rememberInventoryPage('user-a:delivery', {rows:[{id:'private'}],checkedAt:Date.now()});assert.equal(cachedInventoryPage('user-b:delivery'),undefined);
rememberInventoryPage('expired',{rows:[],checkedAt:Date.now()-300001});assert.equal(cachedInventoryPage('expired'),undefined);
let cursor=0,slots=[],effects=[],dirty=true,cleanups=[],clock=10000;const timers=new Map(),intervals=new Map(),listeners={};let timerId=0;
const react={useState(initial){const i=cursor++;if(!slots[i])slots[i]={value:typeof initial==='function'?initial():initial};return[slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;dirty=true;}];},useRef(value){return slots[cursor++]??={current:value};},useCallback(fn,deps){const i=cursor++;if(!slots[i]||deps.some((v,n)=>v!==slots[i].deps[n]))slots[i]={fn,deps};return slots[i].fn;},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,n)=>v!==old.deps[n])){old?.cleanup?.();slots[i]={deps};effects.push(()=>slots[i].cleanup=fn());}}};
const document={visibilityState:'visible',addEventListener:(n,fn)=>listeners[n]=fn,removeEventListener:n=>delete listeners[n]};
const window={addEventListener:(n,fn)=>listeners[n]=fn,removeEventListener:n=>delete listeners[n]};
const hook={exports:{},require:name=>name==='react'?react:sync.exports,Date:{now:()=>Date.now()+clock},AbortController,JSON,globalThis:{window},document,
setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{assert.equal(ms,300000,'Inventory uses five-minute background refresh');intervals.set(++timerId,fn);return timerId;},clearInterval:id=>intervals.delete(id)};
vm.runInNewContext(compile('apps/delivery/src/hooks/useInventoryPage.ts'),hook);
let owner='hook-user',filters={status:'検品中'},view;
async function settle(){for(let i=0;i<25;i++){if(dirty){dirty=false;cursor=0;view=hook.exports.useInventoryPage('delivery',owner,filters);effects.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
async function initial(){await settle();for(const [id,fn]of [...timers]){timers.delete(id);fn();}await settle();}
(async()=>{
response={data:{ids:['a'],rows:[{id:'a',inventory_group_serial:'1894aa'}],fingerprints:{a:'v1'},revision:'page-v1',total:100},error:null};await initial();assert.equal(view.rows.length,1);assert.equal(calls.at(-1).args.p_limit,50);
response={data:{ids:[],rows:[],fingerprints:{},unchanged:true,revision:'page-v1',total:100},error:null};view.updateRow({id:'a',title:'edited'});await settle();assert.equal(view.rows[0].inventory_group_serial,'1894aa','Local detail saves retain parent grouping metadata');
const before=calls.length;document.visibilityState='hidden';clock+=30000;intervals.forEach(fn=>fn());await settle();assert.equal(calls.length,before,'Hidden inventory must not poll');
document.visibilityState='visible';response={data:{ids:[],rows:[],fingerprints:{},unchanged:true,revision:'page-v1',total:100},error:null};intervals.forEach(fn=>fn());await settle();assert.equal(view.rows[0].id,'a');assert.equal(calls.at(-1).args.p_known.a,'v1');assert.equal(calls.at(-1).args.p_known.__revision,'page-v1');
const once=calls.length;listeners.focus();await settle();assert.equal(calls.length,once,'Focus immediately after poll must be deduplicated');
response={data:{ids:['a','b'],rows:[{id:'b'}],fingerprints:{a:'v1',b:'v2'},total:100},error:null};view.loadMore();await initial();assert.equal(calls.at(-1).args.p_limit,100);assert.equal(view.rows.length,2);
response={data:null,error:{message:'temporary network failure'}};await view.refresh();await settle();assert.equal(view.rows.length,2,'Keep visible data after a failed refresh');assert.equal(view.error,'temporary network failure');
response={data:{ids:['b'],rows:[],fingerprints:{b:'v2'},total:1},error:null};await view.refresh();await settle();assert.equal(view.rows.length,1);assert.equal(view.rows[0].id,'b','Deleted/out-of-filter rows must disappear');assert.equal(view.error,null);
owner='different-user';dirty=true;response={data:{ids:[],rows:[],fingerprints:{},total:0},error:null};await initial();assert.deepEqual(plain(calls.at(-1).args.p_known),{},'No cached fingerprints or rows cross users');
let releaseOld;response=new Promise(resolve=>releaseOld=resolve);const oldRequest=view.refresh();await settle();filters={status:'出品中'};dirty=true;response={data:{ids:['new-filter'],rows:[{id:'new-filter'}],fingerprints:{'new-filter':'v1'},total:1},error:null};await initial();releaseOld({data:{ids:['stale'],rows:[{id:'stale'}],fingerprints:{stale:'old'},total:1},error:null});await oldRequest;await settle();assert.equal(view.rows[0].id,'new-filter','Late responses must not overwrite a new filter');
const signal=new AbortController().signal;await fetchInventoryPage('delivery',{},50,{},signal);assert.equal(calls.at(-1).signal,signal);
await assert.rejects(fetchInventoryPage('management',{from:'2026-10-20',to:'2026-10-01'},50),/終了日/);
console.log('Inventory transport: 50/100 paging, fingerprints, deletion, ordering, retained errors/recovery, hidden/focus dedup, per-user cache and abort passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

const groupContext={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/delivery/src/pages/TaskList.tsx','utf8').match(/function serialNumber\(task: DeliveryTask\): string \{[\s\S]*?\n\}/)[0]+'\nexports.groupKey=serialNumber;', {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,groupContext);
const groupKey=groupContext.exports.groupKey;
const bodyGroup=groupKey({id:"body",sku:"1894aa-AAII-20260921-1540",inventory_group_serial:"1894aa"});
assert.equal(groupKey({id:"spare",sku:"1894aaaaa-AAII-20261029-1540",inventory_group_serial:"1894aa"}),bodyGroup);
assert.notEqual(groupKey({id:"other",sku:"1894a-AAEE-20260927-1540",inventory_group_serial:"1894a"}),bodyGroup);
assert.equal(groupKey({id:"legacy",sku:"2000-AAII-20261001-1"}),"2000");
