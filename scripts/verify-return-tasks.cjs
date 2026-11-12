const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const urlModule={exports:{},URL,encodeURIComponent};vm.runInNewContext(compile('packages/shared/src/noticeUrl.ts'),urlModule);
const jsx=(type,props)=>({type,props}),all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
function runtime(){let cursor=0,hooks=[],effects=[];return {react:{useState(initial){const n=cursor++;hooks[n]??={value:initial};return[hooks[n].value,v=>hooks[n].value=typeof v==='function'?v(hooks[n].value):v];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(fn,deps){const n=cursor++;if(!hooks[n]||deps.some((v,i)=>v!==hooks[n].deps[i])){hooks[n]?.cleanup?.();const h=hooks[n]={deps};effects.push(()=>h.cleanup=fn());}}},reset(){cursor=0;},effects(){effects.splice(0).forEach(fn=>fn());},cleanup(){hooks.forEach(h=>h?.cleanup?.());}};}
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
(async()=>{
 const rt=runtime();let writes=0,cancels=0,release,fail=false;const context={exports:{},require:id=>id==='react'?rt.react:id==='react-dom'?{createPortal:n=>n}:{jsx,jsxs:jsx},document:{body:{}}};vm.runInNewContext(compile('apps/admin/src/components/ReturnReasonDialog.tsx'),context);
 const render=()=>{rt.reset();return context.exports.default({label:'写真確認：NG',onSubmit:async r=>{assert.equal(r,'撮り直してください');writes++;if(fail)throw Error('保存エラー');await new Promise(r=>release=r);},onCancel:()=>cancels++});};
 let tree=render();assert(all(tree).find(n=>n.type==='button'&&n.props.type==='submit').props.disabled);tree.props.onCancel({preventDefault(){}});assert.equal(cancels,1);assert.equal(writes,0);
 all(tree).find(n=>n.type==='textarea').props.onChange({target:{value:' 撮り直してください '}});tree=render();const submit=all(tree).find(n=>n.type==='form').props.onSubmit;submit({preventDefault(){}});submit({preventDefault(){}});assert.equal(writes,1);tree=render();tree.props.onCancel({preventDefault(){}});assert.equal(cancels,1);release();await flush();fail=true;tree=render();all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flush();tree=render();assert(all(tree).some(n=>n.props?.role==='alert'));assert.equal(all(tree).find(n=>n.type==='textarea').props.value,' 撮り直してください ');
 const validation={exports:{}};vm.runInNewContext(compile('supabase/functions/delivery-push/validation.ts'),validation);for(const kind of ['photo_return','malfunction_return']){const p=validation.exports.notificationPayload({app_kind:'delivery',kind,lot_seq:2503,item_id:'item'});assert(p.body.includes(kind==='photo_return'?'商品写真の修正お願いします。':'動作不良への返信があります。'));assert.equal(p.itemId,'item');}
 let instant=Date.parse('2026-10-19T01:00:00Z');class Clock extends Date{static now(){return instant;}}
 const listRuntime=runtime();let reads=0,completionCalls=[],completionRelease,completionError=false,navigations=[];
 const common={item_id:'item',expires_at:'2026-10-18T01:00:01Z',sku:'2503b-SKU',lot_seq:2503,marketplace_item_id:'m123',marketplace:'メルカリ',marketplace_url:null};
 let source=[{...common,id:'r',kind:'photo_return',reason:'エラー表示ではなく、別の表示でお願いします。'},{...common,id:'a',kind:'photo_approved',expires_at:new Clock(instant+3*86400000).toISOString()},{...common,id:'m',kind:'reply'},{...common,id:'s',kind:'shipping',expires_at:new Clock(instant+3*86400000).toISOString(),sku:'2390-AALL-20260929-2500',lot_seq:2390,marketplace:'PayPayフリマ',marketplace_item_id:'z694525406'}];
 const listeners={},docListeners={},timers=new Map();let timerId=0;
 const listContext={exports:{},Date:Clock,encodeURIComponent,Set,require:id=>id==='react'?listRuntime.react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='../api'?{completeDeliveryNotice:async(id,item)=>{completionCalls.push({id,item});if(completionError)throw Error('保存に失敗しました');await new Promise(resolve=>completionRelease=resolve);source=source.filter(row=>row.id!==id);}}:{noticeProductUrl:urlModule.exports.noticeProductUrl,readResourceSnapshot:async resource=>{assert.equal(resource,'delivery_work_tasks');reads++;return source;}},window:{location:{assign:url=>navigations.push(url)},setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout(id){timers.delete(id);},addEventListener:(n,fn)=>listeners[n]=fn,removeEventListener:n=>delete listeners[n]},document:{visibilityState:'visible',addEventListener:(n,fn)=>docListeners[n]=fn,removeEventListener:n=>delete docListeners[n]}};
 vm.runInNewContext(compile('apps/delivery/src/components/ReturnTasks.tsx'),listContext);
 const list=()=>{listRuntime.reset();return listContext.exports.default({staffId:'DD'});};
 const card=(tree,title)=>all(tree).find(n=>n.type==='li'&&all(n).some(v=>v.type==='strong'&&v.props.children===title));
 const action=(tree,title)=>all(card(tree,title)).find(n=>n.type==='button');
 list();listRuntime.effects();await flush();tree=list();assert.equal(reads,1);
 assert.deepEqual(all(tree).filter(n=>n.type==='strong').map(n=>n.props.children),['出品お願いします。','発送お願いします。','エラー表示ではなく、別の表示でお願いします。','動作不良への返信があります。']);
 listContext.sortFixture=[{id:'z',kind:'photo_approved',created_at:'2026-10-19'},{id:'a',kind:'photo_approved',created_at:'2026-10-20'},{id:'s',kind:'shipping',created_at:'2026-10-18'}];
 assert.deepEqual(Array.from(vm.runInNewContext('orderedTasks(sortFixture).map(row=>row.id)',listContext)),['z','a','s'],'Category first, then oldest request');
 assert(all(tree).some(n=>n.type==='a'&&n.props.href==='https://jp.mercari.com/item/m123'));assert(all(tree).some(n=>n.type==='a'&&n.props.href==='?itemId=item'));
 const shippingCard=card(tree,'発送お願いします。');assert(shippingCard);assert(shippingCard.props.className.includes('delivery-shipping-task'));assert(all(shippingCard).some(n=>n.type==='a'&&n.props.href==='https://paypayfleamarket.yahoo.co.jp/item/z694525406'));assert(all(shippingCard).some(n=>n.type==='a'&&[].concat(n.props.children).join('')==='【2390】'));assert(all(shippingCard).some(n=>n.type==='span'&&n.props.children==='2390-AALL-20260929-2500'));
 const reason='エラー表示ではなく、別の表示でお願いします。';assert(card(tree,reason));assert.equal(action(tree,'動作不良への返信があります。').props.children,'確認');
 for(const title of [reason,'出品お願いします。','発送お願いします。']){
  const link=all(card(tree,title)).find(n=>n.type==='a'&&n.props.className==='btn');
  assert.equal(link.props.children,'確認');assert.equal(link.props.href,'?itemId=item');
  assert.equal(action(tree,title),undefined,'Work requests wait for actual work records');
 }
 assert.equal(completionCalls.length,0,'Opening task details does not acknowledge completion');
 listeners.focus();listeners.focus();await flush();assert.equal(reads,1,'Focus does not poll repeatedly');
 instant+=7*86400000;tree=list();listRuntime.effects();assert(card(tree,reason));assert(card(tree,'出品お願いします。'));assert(card(tree,'発送お願いします。'),'Uncompleted cards remain beyond three days');assert.equal(timers.size,0,'No expiry timer');
 listeners['delivery-return-tasks-changed']();await flush();assert.equal(reads,2,'Local resubmission immediately refreshes tasks');tree=list();
 listeners['delivery-item-workflow-changed']({detail:{id:'item',status:'出品中',product_registered_at:'2026-10-20',shipped_on:null}});tree=list();assert(!card(tree,'出品お願いします。'),'Listing hides its request without an API roundtrip');assert(!card(tree,'発送お願いします。'),'Cancelled trading hides shipping request');assert(card(tree,reason));assert.equal(reads,2);listeners['delivery-return-tasks-changed']();await flush();tree=list();
 completionError=true;action(tree,'動作不良への返信があります。').props.onClick();await flush();tree=list();assert(card(tree,'動作不良への返信があります。'),'Failed acknowledgement retains reply');assert(all(tree).some(n=>n.props?.role==='alert'));
 completionError=false;const readReply=action(tree,'動作不良への返信があります。').props.onClick;
 readReply();readReply();assert.equal(completionCalls.length,2,'Double click is locked');tree=list();assert.equal(action(tree,'動作不良への返信があります。').props.disabled,true);
 assert.equal(navigations.length,0,'Navigate only after saved acknowledgement');completionRelease();await flush();tree=list();assert(!card(tree,'動作不良への返信があります。'));assert.equal(navigations[0],'?itemId=item&openComments=1');
 assert(card(tree,reason));assert(card(tree,'出品お願いします。'));assert(card(tree,'発送お願いします。'),'Opening a request keeps unfinished work visible');
 listeners['delivery-item-workflow-changed']({detail:{id:'item',status:'取引中',shipped_on:'2026-10-20'}});tree=list();assert(!card(tree,'発送お願いします。'),'Actual shipment dismisses the shipping request');
 const start=new Clock(instant).toISOString();
 const checkHours=3_600_000;
 for(const [kind,warning,overdue] of [['inspection',48,72],['photo_approved',120,168],['listing_due',120,168],['shipping',12,24]]){
  listContext.deadlineFixture={kind,tracking_recorded_at:start,created_at:start};
  for(const [offset,expected] of [[warning*checkHours-1,undefined],[warning*checkHours,'warning'],[overdue*checkHours-1,'warning'],[overdue*checkHours,'overdue']]){
   listContext.at=instant+offset;
   assert.equal(vm.runInNewContext('taskDeadlineTone(deadlineFixture,at)',listContext),expected,kind);
  }
 }
 source=[
  {...common,id:'inspection',kind:'inspection',tracking_recorded_at:start},
  {...common,id:'listing_due',kind:'listing_due',tracking_recorded_at:start},
  {...common,id:'deadline-shipping',kind:'shipping',created_at:start},
 ];
 listeners['delivery-return-tasks-changed']();await flush();tree=list();listRuntime.effects();
 assert(card(tree,'動作確認お願いします。'));assert(!card(tree,'出品お願いします。'));
 assert.equal(all(card(tree,'動作確認お願いします。')).find(n=>n.type==='a'&&n.props.className==='btn').props.href,'?itemId=item');
 const timer=[...timers.values()][0];assert.equal(timer.delay,12*checkHours);
 const beforeTimerReads=reads;
 instant+=12*checkHours;timer.fn();tree=list();listRuntime.effects();
 assert.equal(card(tree,'発送お願いします。').props['data-deadline'],'warning');
 assert.equal(reads,beforeTimerReads,'Deadline colors update without another request');
 instant+=108*checkHours;[...timers.values()][0].fn();tree=list();listRuntime.effects();
 assert.equal(card(tree,'動作確認お願いします。').props['data-deadline'],'overdue');
 assert.equal(card(tree,'出品お願いします。').props['data-deadline'],'warning');
 listeners['delivery-item-workflow-changed']({detail:{id:'item',status:'検品中',inspected:true}});tree=list();
 assert(!card(tree,'動作確認お願いします。'));assert(card(tree,'出品お願いします。'));
 listRuntime.cleanup();assert.equal(timers.size,0);assert.equal(Object.keys(listeners).length,0);
 console.log('PASS: reason required, cancel/Escape no write, double-submit once, failure retains reason; return push deep links; delivery task reasons and bounded event-driven reads');
})().catch(e=>{console.error(e);process.exitCode=1;});
