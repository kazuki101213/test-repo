const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),crypto=require('node:crypto').webcrypto;
const jsx=(type,props)=>({type,props}),all=n=>!n||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(all):[n,...all(n.props?.children)];
const categoryExports={},shipping={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/productCategory.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:categoryExports});
vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/seller.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:shipping,require:()=>categoryExports});
let states=[],cursor=0,effects=[],tree,calls=[];
const react={useState(initial){const i=cursor++;states[i]??={value:initial};return[states[i].value,next=>{states[i].value=typeof next==='function'?next(states[i].value):next;}];},useRef(value){const i=cursor++;return states[i]??={current:value};},useEffect(fn,deps){const i=cursor++;if(!states[i]||deps.some((v,n)=>v!==states[i].deps[n])){states[i]={deps};effects.push(fn);}}};
const task={id:'item',sku:'sample',status:'取引中',sales_channel:'メルカリ'},draft={size:'100',dropoff:'セブンイレブン',shippingMethod:'らくらくメルカリ便',category:'小物'},context={revision:'now',listing:{trade_key:'current'},operations:[]};
const api={fetchTask:async()=>task,fetchSellerContext:async()=>context,queueSellerOperation:async(id,kind,payload)=>{calls.push({id,kind,payload});}};
const shared={...shipping,sellerDefaults:()=>draft,sellerShippingDraft:v=>v,canViewDeliveryAssignee:()=>true};
const c={exports:{},crypto,window:{setInterval(){return 1;},clearInterval(){}},require:id=>id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../api'?api:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/delivery/src/components/SellerPanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,c);
async function render(){for(let i=0;i<8;i++){cursor=0;tree=c.exports.default({mode:'shipping',task,staff:{id:'staff',role:'deliverer'},onClose(){},onChanged(){}});effects.splice(0).forEach(fn=>fn());await Promise.resolve();}}
const selects=()=>all(tree).filter(n=>n.type==='select');
const options=n=>all(n).filter(o=>o.type==='option').map(o=>o.props.children);
const button=()=>all(tree).find(n=>n.type==='button'&&n.props.children==='発送コード表示');
async function choose(index,value){selects()[index].props.onChange({target:{value}});await render();}
function allOptions(){for(const place of ['セブンイレブン','ヤマト営業所','ローソン','郵便局'])assert(options(selects()[2]).includes(place),place);for(const size of ['宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'])assert(options(selects()[1]).includes(size),size);}
(async()=>{
 await render();allOptions();assert(!button().props.disabled);
 assert(!all(tree).some(n=>n.type==='button'&&['店舗での受付を確認','発送通知'].includes(n.props?.children)));
 await choose(0,'ゆうゆうメルカリ便');allOptions();assert.equal(selects()[2].props.value,'セブンイレブン');assert(button().props.disabled);
 await choose(1,'ゆうパケットプラス');await choose(2,'ローソン');allOptions();assert(!button().props.disabled);
 await choose(2,'ヤマト営業所');assert(button().props.disabled);assert(all(tree).some(n=>n.props?.role==='alert'));
 await choose(0,'らくらくメルカリ便');assert(button().props.disabled);
 await choose(1,'宅急便コンパクト');assert(!button().props.disabled);allOptions();
 await choose(2,'セブンイレブン');assert(!button().props.disabled);button().props.onClick();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].kind,'shipping_code');assert.equal(calls[0].payload.dropoff,'セブンイレブン');
 await choose(0,'ゆうゆうメルカリ便');await choose(1,'ゆうパケットポストmini');await choose(2,'ローソン');assert(!all(tree).some(n=>n.type==='button'&&n.props?.children==='発送通知'));assert.equal(calls.length,1);
 console.log('PASS: all small parcel sizes and four places remain visible; incompatible combinations block codes; only explicit valid code request is queued');
})().catch(e=>{console.error(e);process.exitCode=1;});