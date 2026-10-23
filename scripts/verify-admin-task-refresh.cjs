const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
async function check(file,resource){
 let hooks=[],cursor=0,pending=[],dirty=true,tree,now=100000,reads=0,fail=false,hold,blocked=false,rows=[{id:'task',item_id:'item',sku:'123-AA',lot_seq:123,sales_channel:'メルカリ'}];
 const events={},docEvents={},timers=new Map();let timerId=0;
 const document={visibilityState:'visible',addEventListener:(n,f)=>docEvents[n]=f,removeEventListener:n=>delete docEvents[n]};
 const window={setInterval:(f,ms)=>{assert.equal(ms,300000);timers.set(++timerId,f);return timerId;},clearInterval:id=>timers.delete(id),addEventListener:(n,f)=>events[n]=f,removeEventListener:n=>delete events[n]};
 const react={useState(v){const i=cursor++;hooks[i]??={value:typeof v==='function'?v():v};return[hooks[i].value,n=>{hooks[i].value=typeof n==='function'?n(hooks[i].value):n;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const h=hooks[i]={deps};pending.push(()=>h.cleanup=fn());}}};
 const shared={readResourceSnapshot:async name=>{if(name!==resource)return[];reads++;if(blocked)await new Promise(r=>hold=r);if(fail)throw Error('offline');return rows;},getSupabase:()=>({from:()=>({select(){return this;},in:async()=>({data:[],error:null})})})};
 const jsx=(type,props)=>({type,props}),context={exports:{},require:n=>n==='react'?react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='react-dom'?{createPortal:n=>n}:n==='@bussan/shared'?shared:n==='./TaskConfirmation'?{useTaskConfirmation:()=>({ask(){},pending:false})}:n==='../taskNotice'?{adminTaskNotice:()=>null}:n==='../inventory'?{productSerial:()=>123}:n==='../purchaseUrl'?{purchaseItemUrl:()=>null}:n==='../appUrls'?{deliveryAppUrl:'https://example.test/'}:{},window,document,Date:{now:()=>now},Map,Set};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 async function settle(){for(let n=0;n<35;n++){if(dirty){cursor=0;dirty=false;tree=context.exports.default();pending.splice(0).forEach(f=>f());}await Promise.resolve();}}
 await settle();assert.equal(reads,1);assert(JSON.stringify(tree).includes('123-AA'));
 events.focus();docEvents.visibilitychange();await settle();assert.equal(reads,1,'Focus bursts do not reread');
 now+=30001;rows=[];events.focus();await settle();assert.equal(reads,2);assert(!JSON.stringify(tree).includes('123-AA'),'Completed task disappears without reload');
 document.visibilityState='hidden';now+=300001;[...timers.values()][0]();await settle();assert.equal(reads,2,'Hidden pages do not poll');
 document.visibilityState='visible';fail=true;docEvents.visibilitychange();await settle();assert(JSON.stringify(tree).includes('offline'));
 now+=30001;fail=false;rows=[{id:'task2',item_id:'item2',sku:'456-AA',lot_seq:456,sales_channel:'メルカリ'}];events.focus();await settle();assert(JSON.stringify(tree).includes('456-AA'));assert(!JSON.stringify(tree).includes('offline'));
 now+=300001;blocked=true;[...timers.values()][0]();await settle();const before=reads;now+=30001;events.focus();await settle();assert.equal(reads,before,'In-flight read is shared');
 hooks.forEach(h=>h.cleanup?.());assert.equal(timers.size,0);assert.equal(Object.keys(events).length,0);assert.equal(Object.keys(docEvents).length,0);hold();await settle();
}
(async()=>{await check('apps/admin/src/components/ShippingReminderTasks.tsx','admin_shipping_tasks');await check('apps/admin/src/components/PhotoReviewTasks.tsx','listing_tasks');console.log('PASS task auto refresh: remote completion, 5-minute diff poll, focus cooldown, hidden tabs, errors, duplicate requests and cleanup');})().catch(e=>{console.error(e);process.exitCode=1;});
