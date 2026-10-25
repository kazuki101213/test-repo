const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const jsx=(type,props)=>({type,props});
function all(node,result=[]){if(!node||typeof node!=='object')return result;if(Array.isArray(node)){node.forEach(n=>all(n,result));return result;}result.push(node);all(node.props?.children,result);return result;}
function text(node){if(node==null)return '';if(Array.isArray(node))return node.map(text).join('');if(typeof node==='object')return text(node.props?.children);return String(node);}
const task={id:'task',owner_staff_id:'EE',recipient_staff_id:'MM',owner_code:'EE',owner_name:'石川秀樹',recipient_code:'MM',recipient_name:'株式会社吉光',title:'リモコン',manufacturer:'Panasonic純正',marketplace:'メルカリ',marketplace_item_id:'m123',usage_note:'1647 / 1723',lot_seq:2392,sent_at:null,completed_at:null,tracking_no:null};
(async()=>{
for(const app of ['admin','delivery']){
  let cursor=0,hooks=[],dirty=true,tree,props,component,pending=[],sent,completed,changed=0,failed=false;
  const react={
    useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true;}];},
    useRef(value){const i=cursor++;return hooks[i]??={current:value};},
    useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const h=hooks[i]={deps};pending.push(()=>{h.cleanup=fn();});}},
  };
  let now=1000000,tick,intervalMs,reads=0;
  let fixtures=[task,{...task,id:'other',owner_staff_id:'II'},{...task,id:'sent',sent_at:'now'}],focus;
  const shared={canViewDeliveryAssignee:s=>s.code==='AA'&&s.role==='admin',staffDisplayName:p=>p.code+' '+p.name,fetchSpareShippingTasks:async()=>{reads++;return fixtures;},
    sendSpareShipping:async(id,tracking)=>{if(failed)throw{message:'送信に失敗しました'};sent={id,tracking};},
    completeSpareShipping:async id=>{if(failed)throw{message:'完了に失敗しました'};completed=id;}};
  const context={Date:{now:()=>now},exports:{},require:id=>id==='../purchaseUrl'?{purchaseItemUrl:(site,id)=>id==='m123'?'https://jp.mercari.com/item/m123':null}:id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:shared,
    window:{setInterval:(fn,ms)=>{tick=fn;intervalMs=ms;return 1;},clearInterval(){},addEventListener(name,fn){if(name==='focus')focus=fn;},removeEventListener(){}},
    document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
  const source=fs.readFileSync('apps/'+app+'/src/components/SpareShippingTasks.tsx','utf8')+'\nexport { ShippingRow };';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  function render(){cursor=0;dirty=false;tree=component(props);pending.splice(0).forEach(fn=>fn());}
  async function settle(){for(let i=0;i<12;i++){if(dirty)render();await Promise.resolve();}}
  async function mount(fn,value){hooks.forEach(h=>h?.cleanup?.());hooks=[];component=fn;props=value;dirty=true;await settle();}
  const button=label=>all(tree).find(n=>n.type==='button'&&text(n)===label);
  await mount(context.exports.default,{staff:{id:'EE',role:'purchaser'}});
  assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task']);
  await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'},management:true});
  assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task','other'],'Sent tasks must not require admin completion');
  fixtures=fixtures.map(row=>row.id==='task'?{...row,sent_at:'sent-elsewhere'}:row);
  focus();await settle();
  assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['other'],'Sending from another app automatically removes the task on refresh');
  assert.equal(completed,undefined,'Automatic removal must not issue another completion write');
  assert.equal(intervalMs,app==='admin'?300000:86400000,'Management uses the existing five-minute task refresh cadence; delivery keeps its daily refresh');
  const before=reads;focus();focus();await settle();assert.equal(reads,before,'Repeated focus must not duplicate downloads');
  context.document.visibilityState='hidden';now+=intervalMs;tick();await settle();assert.equal(reads,before,'Hidden pages do not poll');
  context.document.visibilityState='visible';
  now+=intervalMs;tick();await settle();
  assert.equal(reads-before,1,'One visible day needs only one periodic shipping check');
  fixtures=[task,{...task,id:'other',owner_staff_id:'II'},{...task,id:'sent',sent_at:'now'}];
  await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'},management:true});
  all(tree).find(n=>typeof n.type==='function'&&n.props.task.id==='task').props.onChanged();await settle();
  assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['other'],'A stale refresh must not restore a successfully sent task');
  if(app==='delivery'){
    await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'}});
    assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task','other']);
    // Simulate a successful row action followed by a stale in-flight server response.
    all(tree).find(n=>typeof n.type==='function'&&n.props.task.id==='task').props.onChanged();await settle();
    assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['other'],'Successful send must stay dismissed even if refresh returns old unsent rows');
    await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'},management:true});
    assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task','other'],'Management hides sent tasks without another completion');
    await mount(context.exports.ShippingRow,{task,staff:{id:'AA',code:'AA',role:'admin'},management:false,onChanged:()=>changed++});
    assert(text(tree).includes('EE 石川秀樹→MM 株式会社吉光の発送準備中'));assert(button('発送'));assert(!button('完了'));
    assert(tree.props.className.includes('delivery-return-task'),'Delivery spare shipping must use the same card border as the other notices');
    assert.equal(all(tree).filter(n=>n.props?.className==='spare-shipping-detail-line').length,3,'Delivery details retain the three requested line groups');
    assert(tree.props.children.includes(button('発送')),'Shipping button is a direct card grid child, not below the details');
    button('発送').props.onClick();await settle();
    all(tree).find(n=>n.type==='input'&&n.props.type!=='checkbox').props.onChange({target:{value:'admin-tracking'}});await settle();
    all(tree).find(n=>n.props?.type==='checkbox').props.onChange({target:{checked:true}});await settle();
    all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
    assert.equal(sent.id,'task');assert.equal(sent.tracking,'admin-tracking');assert.equal(changed,1);changed=0;
    await mount(context.exports.ShippingRow,{task,staff:{id:'II',code:'II',role:'deliverer'},management:false,onChanged:()=>changed++});assert(!button('発送'));
    await mount(context.exports.ShippingRow,{task,staff:{id:'other-admin',code:'DD',role:'admin'},management:false,onChanged:()=>changed++});assert(!button('発送'));
    await mount(context.exports.ShippingRow,{task:{...task,sent_at:'now',tracking_no:'12345'},staff:{id:'AA',code:'AA',role:'admin'},management:false,onChanged:()=>changed++});
    assert(text(tree).includes('発送済み'));assert(text(tree).includes('追跡番号：12345'));assert(!button('完了'));
  }
  await mount(context.exports.ShippingRow,{task,staff:{id:'EE',role:'purchaser'},management:false,onChanged:()=>changed++});
  if(app==='delivery'){
    const sourceLink=all(tree).find(n=>n.type==='a'&&n.props['aria-label']==='仕入先の商品ページを開く');
    assert.equal(sourceLink.props.href,'https://jp.mercari.com/item/m123');
    assert.equal(sourceLink.props.rel,'noopener noreferrer');
    await mount(context.exports.ShippingRow,{task:{...task,marketplace_item_id:'javascript:alert(1)'},staff:{id:'EE',role:'purchaser'},management:false,onChanged:()=>changed++});
    assert(!all(tree).some(n=>n.type==='a'),'Invalid IDs must not create supplier links');
    await mount(context.exports.ShippingRow,{task,staff:{id:'EE',role:'purchaser'},management:false,onChanged:()=>changed++});
  }
  for(const value of ['MM 株式会社吉光へ発送お願いします。','リモコン','Panasonic純正','メルカリ','m123','1647 / 1723'])assert(text(tree).includes(value));
  button('発送').props.onClick();await settle();
  assert(button('送信').props.disabled);
  all(tree).find(n=>n.type==='input'&&n.props.type!=='checkbox').props.onChange({target:{value:'  12345  '}});await settle();
  assert(button('送信').props.disabled);sent=undefined;
  all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(sent,undefined);assert.equal(changed,0);
  assert(text(tree).includes('通番号/利用記録：2392 / 1647 / 1723'));
  assert(text(tree).includes('通番号に◯をつけましたか？'));
  assert(text(tree).indexOf('通番号：2392')<text(tree).indexOf('品名：リモコン'));
  all(tree).find(n=>n.props?.type==='checkbox').props.onChange({target:{checked:true}});await settle();assert(!button('送信').props.disabled);
  failed=true;all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert(text(tree).includes('送信に失敗しました'));assert.equal(changed,0);
  failed=false;all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert.equal(sent.id,'task');assert.equal(sent.tracking,'12345');assert.equal(changed,1);
  await mount(context.exports.ShippingRow,{task,staff:{id:'EE',role:'purchaser'},management:false,onChanged:()=>changed++});
  button('発送').props.onClick();await settle();
  all(tree).find(n=>n.props?.type==='checkbox').props.onChange({target:{checked:true}});await settle();
  button('キャンセル').props.onClick();await settle();button('発送').props.onClick();await settle();
  assert.equal(all(tree).find(n=>n.props?.type==='checkbox').props.checked,false);assert(button('送信').props.disabled);
  if(app==='admin'){
    await mount(context.exports.ShippingRow,{task,staff:{id:'EE',role:'admin'},management:true,onChanged:()=>changed++});
    assert(button('完了'),'Management may acknowledge without shipping');
    assert(text(tree).includes('通番号：2392品名：リモコンメーカー：Panasonic純正仕入先：メルカリ商品ID：m123利用記録：1647 / 1723')); assert(!button('発送')); assert.equal(all(tree).filter(n=>n.props?.className==='spare-shipping-detail-line').length,3);
    assert.equal(all(tree).find(n=>n.type==='a').props.href,'https://jp.mercari.com/item/m123');
  }
  await mount(context.exports.ShippingRow,{task,staff:{id:'AA',code:'AA',role:'admin'},management:true,onChanged:()=>changed++});
  assert(text(tree).includes('EE 石川秀樹→MM 株式会社吉光の発送準備中'));assert.equal(!!button('完了'),app==='admin');
  if(app==='admin'){
    assert(!button('発送'),'Management shows shipping progress without performing shipment');
    assert(!all(tree).some(n=>n.type==='form'),'Management never offers a shipping form');
    failed=true;button('完了').props.onClick();await settle();assert.equal(completed,undefined);assert(all(tree).some(n=>n.props?.role==='alert'));
    failed=false;button('完了').props.onClick();button('完了').props.onClick();await settle();assert.equal(completed,'task');assert.equal(changed,2);
    await mount(context.exports.ShippingRow,{task,staff:{id:'other-admin',code:'DD',role:'admin'},management:true,onChanged:()=>changed++});
    assert(!button('発送'),'Other administrators retain the holder-only permission');
  }
  await mount(context.exports.ShippingRow,{task:{...task,sent_at:'now',tracking_no:'12345'},staff:{id:'AA',code:'AA',role:'admin'},management:true,onChanged:()=>changed++});
  assert(text(tree).includes('発送済み'));assert(text(tree).includes('通番号：2392'));assert(text(tree).includes('追跡番号：12345'));assert(!text(tree).includes('利用記録'));
  assert(!button('完了'),'Sent tasks no longer offer a second completion button');assert.equal(completed,app==='admin'?'task':undefined);assert.equal(changed,app==='admin'?2:1);
  fixtures=[{...task,management_completed_at:'acknowledged'}];
  await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'},management:true});
  assert.equal(all(tree).filter(n=>typeof n.type==='function').length,app==='admin'?0:1,'Management acknowledgement hides only the management card');
}
console.log('Both apps: holder scope, requested details, checked shipping, cancel reset, error retry and automatic sent-task dismissal without extra completion passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
