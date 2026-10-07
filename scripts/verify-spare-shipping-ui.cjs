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
  const shared={canViewDeliveryAssignee:s=>s.code==='AA'&&s.role==='admin',staffDisplayName:p=>p.code+' '+p.name,fetchSpareShippingTasks:async()=>[task,{...task,id:'other',owner_staff_id:'II'},{...task,id:'sent',sent_at:'now'}],
    sendSpareShipping:async(id,tracking)=>{if(failed)throw{message:'送信に失敗しました'};sent={id,tracking};},
    completeSpareShipping:async id=>{completed=id;}};
  const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:shared,
    window:{setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}},
    document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
  const source=fs.readFileSync('apps/'+app+'/src/components/SpareShippingTasks.tsx','utf8')+'\nexport { ShippingRow };';
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
  function render(){cursor=0;dirty=false;tree=component(props);pending.splice(0).forEach(fn=>fn());}
  async function settle(){for(let i=0;i<12;i++){if(dirty)render();await Promise.resolve();}}
  async function mount(fn,value){hooks.forEach(h=>h?.cleanup?.());hooks=[];component=fn;props=value;dirty=true;await settle();}
  const button=label=>all(tree).find(n=>n.type==='button'&&text(n)===label);
  await mount(context.exports.default,{staff:{id:'EE',role:'purchaser'}});
  assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task']);
  if(app==='delivery'){
    await mount(context.exports.default,{staff:{id:'AA',code:'AA',role:'admin'}});
    assert.deepEqual(all(tree).filter(n=>typeof n.type==='function').map(n=>n.props.task.id),['task','other','sent']);
    await mount(context.exports.ShippingRow,{task,staff:{id:'AA',code:'AA',role:'admin'},management:false,onChanged:()=>changed++});
    assert(text(tree).includes('EE 石川秀樹→MM 株式会社吉光の発送準備中'));assert(!button('完了'));
    await mount(context.exports.ShippingRow,{task:{...task,sent_at:'now',tracking_no:'12345'},staff:{id:'AA',code:'AA',role:'admin'},management:false,onChanged:()=>changed++});
    assert(text(tree).includes('発送済み'));assert(text(tree).includes('追跡番号：12345'));assert(!button('完了'));
  }
  await mount(context.exports.ShippingRow,{task,staff:{id:'EE',role:'purchaser'},management:false,onChanged:()=>changed++});
  for(const value of ['MM 株式会社吉光へ発送お願いします。','リモコン','Panasonic純正','メルカリ','m123','1647 / 1723'])assert(text(tree).includes(value));
  button('完了').props.onClick();await settle();
  assert(button('送信').props.disabled);
  all(tree).find(n=>n.type==='input').props.onChange({target:{value:'  12345  '}});await settle();
  failed=true;all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert(text(tree).includes('送信に失敗しました'));assert.equal(changed,0);
  failed=false;all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert.equal(sent.id,'task');assert.equal(sent.tracking,'12345');assert.equal(changed,1);
  await mount(context.exports.ShippingRow,{task,staff:{id:'AA',role:'admin'},management:true,onChanged:()=>changed++});
  assert(text(tree).includes('EE 石川秀樹→MM 株式会社吉光の発送準備中'));assert(!button('完了'));
  await mount(context.exports.ShippingRow,{task:{...task,sent_at:'now',tracking_no:'12345'},staff:{id:'AA',role:'admin'},management:true,onChanged:()=>changed++});
  assert(text(tree).includes('発送済み'));assert(text(tree).includes('通番号：2392'));assert(text(tree).includes('追跡番号：12345'));assert(!text(tree).includes('利用記録'));
  button('完了').props.onClick();await settle();assert.equal(completed,'task');assert.equal(changed,2);
}
console.log('Both apps: holder scope, requested details, completion/input/send, error retry, admin pending/sent/completion passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
