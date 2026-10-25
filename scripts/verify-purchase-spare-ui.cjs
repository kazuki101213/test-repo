const fs=require('node:fs'), vm=require('node:vm'), ts=require('typescript'), assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const names={exports:{}};vm.runInNewContext(compile('packages/shared/src/staffNames.ts'),names);
const skus={exports:{}};vm.runInNewContext(compile('packages/shared/src/sku.ts'),skus);
const codes=['AA','DD','EE','HH','II','KK','LL','MM'];
const staff=[...codes,'FF','GG','JJ','NN'].reverse().map(code=>({id:code,code,name:code==='AA'?'長部一輝':code,role:code==='AA'?'admin':'deliverer',is_active:code!=='NN'}));
assert.deepEqual(Array.from(names.exports.deliveryStaffOptions(staff),s=>s.code),codes);
assert.equal(names.exports.staffDisplayName({name:'old',code:'AA',display_name:'old'}),'AA 長部 一輝');
const spare={id:'spare',title:'リモコン',cost_amount:1230,purchased_at:'2026-09-01',marketplace:'ヤフオク',marketplace_item_id:'spare-id',tracking_no:'spare-track',owner_staff_id:'AA'};
let cursor=0, dirty=true, tree, pending=[], saved, selectedDraft;const hooks=[];
const react={
 useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof initial==='function'?initial():initial};return[hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true;}];},
 useLayoutEffect(){},
 useRef(value){const i=cursor++;return(hooks[i]??={current:value});},
 useEffect(fn,deps){const i=cursor++,old=hooks[i];if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const h=hooks[i]={deps};pending.push(()=>{h.cleanup=fn();});}},
};
const jsx=(type,props)=>({type,props});
const shared={...names.exports,...skus.exports,CONDITIONS:['非常に良い'],MARKETPLACES:['メルカリ','ヤフオク','その他','Amazon返品','動作品Amazon返品'],SALES_CHANNELS:['FBA'],WORK_STREAMS:['ブルーレイ','付属品'],yen:v=>String(v),fetchSpareAccessories:async()=>currentSpares};
let currentSpares=[spare];
const api={fetchStaff:async()=>staff,fetchCards:async()=>[{id:'amex',name:'アメックスカード'}],nextLotSeq:async()=>5000,fetchProducts:async()=>[],createItem:async(payload,id)=>{saved={payload,id};return{id:'created',sku:'body-sku',accessory_sku:'accessory-sku'};}};
const context={exports:{},require:id=>id==='../components/entryWidth'?require('./entry-width-module.cjs'):id==='react'?react:id==='react/jsx-runtime'?{jsx,jsxs:jsx}:id==='@bussan/shared'?shared:id==='../api'?api:id==='../purchaseUrl'?{buildPurchaseUrl:()=>null,parsePurchaseUrl:()=>null}:{default:'select'},setTimeout:fn=>{fn();return 1;},clearTimeout(){},Date,URL,window:{setInterval(){},clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
vm.runInNewContext(compile('apps/admin/src/pages/NewPurchase.tsx'),context);
function render(){cursor=0;dirty=false;tree=context.exports.default({me:staff.find(s=>s.code==='AA'),draft:selectedDraft});for(const fn of pending.splice(0))fn();}
async function settle(){for(let i=0;i<12;i++){if(dirty)render();await Promise.resolve();}}
function all(node,output=[]){if(!node||typeof node!=='object')return output;if(Array.isArray(node)){node.forEach(n=>all(n,output));return output;}output.push(node);all(node.props?.children,output);return output;}
function field(label){const node=all(tree).find(n=>n.type==='label'&&all(n.props.children).some(c=>c.type==='span'&&c.props.children===label));assert(node,label);return all(node.props.children).find(n=>n.type==='input'||n.type==='select'||n.type==='textarea'||n.type==='default');}
(async()=>{
 await settle();
 assert.equal(field('支払い方法').props.value,'amex');assert.equal(field('作業ライン').props.value,'ブルーレイ');
 for(const [label,value] of [['納品担当者','DD'],['型番','本体型番'],['ASIN','B000000001'],['仕入金額（円）','43210'],['商品ID','body-id'],['追跡番号','body-track'],['作業ライン','ブルーレイ']]){field(label).props.onChange({target:{value}});await settle();}
 all(tree).find(n=>n.type==='input'&&n.props.name==='purchase-spare'&&n.props.value==='spare').props.onChange();await settle();
 for(const [label,value] of [['納品担当者','DD'],['型番','本体型番'],['ASIN','B000000001'],['仕入金額（円）',43210],['商品ID','body-id'],['追跡番号','body-track']])assert.equal(field(label).props.value,value,label+' must stay unchanged');
 assert.deepEqual(all(field('納品担当者')).filter(n=>n.type==='option'&&n.props.value).map(n=>n.props.value),codes);
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert(saved);assert.equal(saved.id,'spare');assert.equal(saved.payload.title,'本体型番');assert.equal(saved.payload.cost_amount,43210);assert.equal(saved.payload.is_accessory,false);
 // A reserve allocated in another screen is rejected before registration, without clearing body inputs.
 hooks.splice(0);cursor=0;pending=[];saved=undefined;dirty=true;await settle();
 for(const [label,value] of [['納品担当者','DD'],['型番','維持する本体'],['ASIN','B000000002'],['仕入金額（円）','24409'],['商品ID','c1243675380'],['追跡番号','body-track']]){field(label).props.onChange({target:{value}});await settle();}
 all(tree).find(n=>n.type==='input'&&n.props.name==='purchase-spare'&&n.props.value==='spare').props.onChange();await settle();
 currentSpares=[{...spare,used_for_item_id:'other-item'}];
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert.equal(saved,undefined);assert(JSON.stringify(tree).includes('すでに別の商品に使用'));assert.equal(field('型番').props.value,'維持する本体');assert.equal(field('仕入金額（円）').props.value,24409);assert.equal(field('商品ID').props.value,'c1243675380');
 api.createItem=async()=>{throw{message:'登録できません',details:'具体的な原因',hint:'再度確認してください'};};
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert(JSON.stringify(tree).includes('登録できません 具体的な原因 再度確認してください'));assert(!JSON.stringify(tree).includes('[object Object]'));assert.equal(field('型番').props.value,'維持する本体');
 // A selected import product fetches exactly its ID, never the whole product catalog.
 hooks.splice(0);cursor=0;pending=[];dirty=true;let lookups=[];
 api.fetchProduct=async id=>{lookups.push(id);return{id,asin:'B000000003',model_no:'SELECTED',maker:'SONY'};};
 api.fetchProducts=async()=>{throw Error('Full catalog must not be read for a selected product');};
 selectedDraft={id:'draft',product_id:'selected-product',asin:'B000000003',model_no:'SELECTED',title:'SELECTED',marketplace:'ヤフオク',marketplace_item_id:'sample',purchased_at:'2026-10-01',cost_amount:1230};
 await settle();assert.deepEqual(lookups,['selected-product']);assert.equal(field('ASIN').props.value,'B000000003');
 console.log('Stale reserve prevented before save, input preservation and plain database error display passed');
 // The exact multi-letter serial must reach the atomic reserve registration.
 hooks.splice(0);cursor=0;pending=[];selectedDraft=null;dirty=true;currentSpares=[spare];saved=undefined;
 api.createItem=async(payload,id)=>{saved={payload,id};return{id:'created',sku:payload.sku};};
 await settle();field('作業ライン').props.onChange({target:{value:'付属品'}});await settle();
 assert.equal(field('通番号').props.type,'text');assert.equal(field('通番号').props.inputMode,'text');
 field('通番号').props.onChange({target:{value:'1894AA'}});await settle();
 all(tree).find(n=>n.type==='input'&&n.props.name==='purchase-spare'&&n.props.value==='spare').props.onChange();await settle();
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
 assert(saved);assert.equal(saved.id,'spare');assert.equal(saved.payload.lot_seq,1894);assert.match(saved.payload.sku,/^1894aa-/);assert.equal(saved.payload.is_accessory,true);
 const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
 let parents=[{id:'root',lot_seq:1894,sku:'1894-AADD-20261001-100'},{id:'returned',lot_seq:1894,sku:'1894aa-AAII-20261002-0'}],requests=[];
 const db={from(){return{select(){return this},eq(){return this},then(resolve){return Promise.resolve({data:parents,error:null}).then(resolve)}}},rpc:async(name,args)=>{requests.push(args);return{data:{id:'registered',sku:args.p_item.sku},error:null}}};
 const realApi={exports:{},require:id=>id==='@bussan/shared'?{getSupabase:()=>db}:id==='./inventory'?inventory.exports:{}};vm.runInNewContext(compile('apps/admin/src/api.ts'),realApi);
 await realApi.exports.createItem(saved.payload,'spare');assert.match(requests[0].p_item.sku,/^1894aa-/);
 parents=[parents[0]];await assert.rejects(()=>realApi.exports.createItem(saved.payload,'spare'),/一意/);assert.equal(requests.length,1,'Never attach 1894aa to the only available 1894 body');
 // User's failing combination: an Amazon-return reserve is attached to 1894aa.
 for(const marketplace of ['Amazon返品','動作品Amazon返品']){
  hooks.splice(0);cursor=0;pending=[];selectedDraft=null;dirty=true;saved=undefined;currentSpares=[{...spare,marketplace}];let returnLookups=0;
  api.findInventoryForAmazonReturn=async()=>{returnLookups++;throw Error('Accessory registration must not allocate a new return suffix');};
  await settle();field('作業ライン').props.onChange({target:{value:'付属品'}});await settle();
  field('通番号').props.onChange({target:{value:'1894aa'}});await settle();
  all(tree).find(n=>n.type==='input'&&n.props.name==='purchase-spare'&&n.props.value==='spare').props.onChange();await settle();
  assert.equal(field('仕入先').props.value,marketplace);assert.equal(field('作業ライン').props.value,'付属品');assert.equal(field('通番号').props.value,'1894aa');
  await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert.equal(returnLookups,0);assert(saved);assert.equal(saved.payload.is_accessory,true);assert.equal(saved.payload.marketplace,marketplace);assert.equal(saved.payload.title,'リモコン');assert.match(saved.payload.sku,/^1894aa-/);
  parents=[{id:'original',lot_seq:1894,sku:'1894-EEKK-20260701-1540'},{id:'return-a',lot_seq:1894,sku:'1894a-AAEE-20260927-0'},{id:'return-aa',lot_seq:1894,sku:'1894aa-AAII-20260921-0'}];
  await realApi.exports.createItem(saved.payload,'spare');assert.match(requests.at(-1).p_item.sku,/^1894aa-/);
 }
 console.log('Main form preserved; atomic spare save retains 1894aa; exact eight ordered assignee options passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
