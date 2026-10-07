const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript'), assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const names={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),names);
const codes=['AA','DD','EE','HH','II','KK','LL','MM'];
const staff=[...codes,'FF','GG','JJ','NN'].reverse().map(code=>({id:code,code,name:code==='AA'?'長部一輝':code,role:code==='AA'?'admin':'deliverer',is_active:code!=='NN'}));
assert.deepEqual(Array.from(names.exports.deliveryStaffOptions(staff),s=>s.code),codes);
assert.equal(names.exports.staffDisplayName({name:'old',code:'AA',display_name:'old'}),'AA 長部 一輝');
const spare={id:'spare',title:'リモコン',cost_amount:1230,purchased_at:'2026-09-01',marketplace:'ヤフオク',marketplace_item_id:'spare-id',tracking_no:'spare-track',owner_staff_id:'AA'};
let cursor=0, dirty=true, tree, pending=[], saved;const hooks=[];
const react={
 useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true;}];},
 useRef(value){const i=cursor++;return(hooks[i]??={current:value});},
 useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const h=hooks[i]={deps};pending.push(()=>{h.cleanup=fn();});}},
};
const jsx=(type,props)=>({type,props});
const shared={...names.exports,CONDITIONS:['非常に良い'],MARKETPLACES:['メルカリ','ヤフオク','その他'],SALES_CHANNELS:['FBA'],WORK_STREAMS:['ブルーレイ','付属品'],yen:v=>String(v),fetchSpareAccessories:async()=>[spare]};
const api={fetchStaff:async()=>staff,fetchCards:async()=>[],nextLotSeq:async()=>5000,fetchProducts:async()=>[],createItem:async(payload,id)=>{saved={payload,id};return{id:'created',sku:'body-sku',accessory_sku:'accessory-sku'};}};
const context={exports:{},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../api'?api:id==='../purchaseUrl'?{buildPurchaseUrl:()=>null,parsePurchaseUrl:()=>null}:{default:'select'},setTimeout:fn=>{fn();return 1;},clearTimeout(){},Date,URL};
vm.runInNewContext(compile('apps/admin/src/pages/NewPurchase.tsx'),context);
function render(){cursor=0;dirty=false;tree=context.exports.default({me:staff.find(s=>s.code==='AA')});for(const fn of pending.splice(0))fn();}
async function settle(){for(let i=0;i<12;i++){if(dirty)render();await Promise.resolve();}}
function all(node,output=[]){if(!node||typeof node!=='object')return output;if(Array.isArray(node)){node.forEach(n=>all(n,output));return output;}output.push(node);all(node.props?.children,output);return output;}
function field(label){const node=all(tree).find(n=>n.type==='label'&&all(n.props.children).some(c=>c.type==='span'&&c.props.children===label));assert(node,label);return all(node.props.children).find(n=>n.type==='input'||n.type==='select'||n.type==='textarea'||n.type==='default');}
(async()=>{
 await settle();
 for(const [label,value] of [['型番','本体型番'],['ASIN','B000000001'],['仕入金額（円）','43210'],['商品ID','body-id'],['追跡番号','body-track'],['作業ライン','ブルーレイ']]){field(label).props.onChange({target:{value}});await settle();}
 all(tree).find(n=>n.type==='input'&&n.props.name==='purchase-spare'&&n.props.value==='spare').props.onChange();await settle();
 for(const [label,value] of [['型番','本体型番'],['ASIN','B000000001'],['仕入金額（円）',43210],['商品ID','body-id'],['追跡番号','body-track']])assert.equal(field(label).props.value,value,label+' must stay unchanged');
 assert.deepEqual(all(field('納品担当者')).filter(n=>n.type==='option'&&n.props.value).map(n=>n.props.value),codes);
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert(saved);assert.equal(saved.id,'spare');assert.equal(saved.payload.title,'本体型番');assert.equal(saved.payload.cost_amount,43210);assert.equal(saved.payload.is_accessory,false);
 console.log('Main form preserved on spare selection; one atomic save; exact eight ordered assignee options passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
