const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
let cursor=0,hooks=[],dirty=true,tree,pending=[],calls=[],done=0,closed=0,fail=true,release;
const react={useState(value){const i=cursor++;hooks[i]??={value};return[hooks[i].value,value=>{hooks[i].value=value;dirty=true;}];},useRef(value){const i=cursor++;return hooks[i]??={current:value};},useEffect(fn,deps){const i=cursor++;if(!hooks[i]){hooks[i]={deps};pending.push(fn);}}};
const jsx=(type,props)=>({type,props});
const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?{deliveryStaffOptions:s=>s,staffDisplayName:s=>s.name}:id==='../api'?{registerPurchaseDraftSpare:async(id,payload)=>{calls.push({id,payload});if(fail)throw{message:'登録エラー'};await new Promise(resolve=>release=resolve);return'spare';}}:{default:'date'}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/components/PurchaseDraftToSpare.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
const props={draft:{id:'draft',title:'TOSHIBA レコーダー用リモコン SE-R0435',marketplace:'メルカリ',marketplace_item_id:'m-fixture',purchased_at:'2026-10-25',cost_amount:1800},staff:[{id:'holder',name:'保管担当者'}],onClose:()=>closed++,onRegistered:()=>done++};
function all(node,out=[]){if(!node||typeof node!=='object')return out;if(Array.isArray(node)){node.forEach(n=>all(n,out));return out;}out.push(node);all(node.props?.children,out);return out;}
function field(label){const n=all(tree).find(n=>n.type==='label'&&n.props.children[0].props.children===label);return n.props.children[1];}
async function settle(){for(let i=0;i<12;i++){if(dirty){cursor=0;dirty=false;tree=context.exports.default(props);pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
const submit=()=>all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
(async()=>{
 await settle();assert.equal(field('品名').props.value,'リモコン');assert.equal(field('メーカー').props.value,'TOSHIBA');assert.equal(field('購入日').props.value,'2026-10-25');assert.equal(field('仕入金額').props.value,'1800');
 submit();await settle();assert.equal(calls.length,0,'Missing holder must not write');
 field('保管担当者').props.onChange({target:{value:'holder'}});await settle();submit();await settle();
 assert.equal(done,0);assert.equal(closed,0);assert.equal(field('保管担当者').props.value,'holder');assert(JSON.stringify(tree).includes('登録エラー'),'Errors remain visible without closing the draft');
 fail=false;submit();submit();await settle();assert.equal(calls.length,2,'Double clicks must not register twice');assert.equal(done,0);assert.equal(calls[1].payload.title,'リモコン');assert(!('usage_note' in calls[1].payload));
 tree.props.onCancel({preventDefault(){}});assert.equal(closed,0,'Pending registration cannot be cancelled');
 release();await settle();assert.equal(done,1);assert.equal(closed,0);
 const source=fs.readFileSync('apps/admin/src/pages/Inventory.tsx','utf8');assert(!source.includes('>予備登録</button>'),'Spare registration belongs only beside the inventory form save button');assert(source.includes('>在庫へ反映</button>'));
 console.log('Draft to spare: inherited fields, validation, failure retention, double-click lock and success passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
