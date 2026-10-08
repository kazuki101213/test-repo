const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=p=>ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const url={exports:{},URL};vm.runInNewContext(compile('apps/admin/src/purchaseUrl.ts'),url);
let reference={marketplace:'ヤフオク',marketplace_item_id:'k1242592890',marketplace_url:'https://auctions.yahoo.co.jp/jp/auction/k1242592890'},calls=[];
const root={id:'main',sku:'2305-EELL-20260911-1339',marketplace:'ヤフオク',title:'model',lot_seq:2305,purchased_at:'2026-09-11',cost_amount:1339},returned={...root,id:'return',sku:'2305a-EELL-20260911-1339'};
function client(){return {from(table){let columns;const q={select(v){columns=v;calls.push([table,v]);return q;},eq(){return q;},maybeSingle(){return Promise.resolve({data:reference,error:null});},then(resolve){return Promise.resolve({data:[returned,root],error:null}).then(resolve);}};return q;}};}
const api={exports:{},require:n=>n==='@bussan/shared'?{getSupabase:client}:n==='./purchaseUrl'?url.exports:{}};
vm.runInNewContext(compile('apps/admin/src/api.ts'),api);
const jsx=(type,props)=>({type,props});function all(n,out=[]){if(Array.isArray(n))n.forEach(x=>all(x,out));else if(n&&typeof n==='object'){out.push(n);all(n.props?.children,out);}return out;}
(async()=>{
const source=await api.exports.findInventoryForAmazonReturn(2305);assert.equal(source.original_sku,root.sku);assert.equal(source.sku,'2305aa-EELL-20260911-1339');assert.equal(source.marketplace_item_id,reference.marketplace_item_id);assert.equal(source.marketplace_url,reference.marketplace_url);assert(calls.some(c=>c[0]==='items'&&c[1].includes('marketplace_url')));
reference={...reference,marketplace_url:null};assert.equal((await api.exports.findInventoryForAmazonReturn(2305)).marketplace_url,'https://auctions.yahoo.co.jp/jp/auction/k1242592890');
reference={marketplace:'その他',marketplace_item_id:null,marketplace_url:null};assert.equal((await api.exports.findInventoryForAmazonReturn(2305)).marketplace_url,null);
for(const marketplace of ['Amazon返品','動作品Amazon返品']){
let hooks=[],cursor=0,dirty=true,pending=[],tree;
const react={useState(v){const n=cursor++;hooks[n]??={value:typeof v==='function'?v():v};return[hooks[n].value,x=>{hooks[n].value=typeof x==='function'?x(hooks[n].value):x;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useEffect(fn,deps){const n=cursor++,h=hooks[n];if(!h||deps.some((x,j)=>x!==h.deps[j])){h?.cleanup?.();hooks[n]={deps};pending.push(()=>hooks[n].cleanup=fn());}},useLayoutEffect(){cursor++;}};
const ctx={exports:{},require:n=>n==='react'?react:n==='react/jsx-runtime'?{jsx,jsxs:jsx}:n==='@bussan/shared'?{STAFF_DISPLAY_NAMES:{},staffDisplayName:s=>s.name,deliveryStaffOptions:s=>s,CONDITIONS:[],MARKETPLACES:['メルカリ',marketplace],SALES_CHANNELS:[],WORK_STREAMS:[],yen:n=>n,fetchSpareAccessories:async()=>[]}:n==='../purchaseUrl'?url.exports:n==='../api'?{findInventoryForAmazonReturn:async()=>source,fetchStaff:async()=>[],fetchCards:async()=>[],nextLotSeq:async()=>2305,fetchProducts:async()=>[]}:{default:'select'},Date,Set,Map,setTimeout:()=>1,clearTimeout(){},window:{setInterval(){},clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
vm.runInNewContext(compile('apps/admin/src/pages/NewPurchase.tsx'),ctx);async function settle(){for(let n=0;n<15;n++){if(dirty){cursor=0;dirty=false;tree=ctx.exports.default({me:{id:'AA'}});pending.splice(0).forEach(fn=>fn());}await Promise.resolve();}}
await settle();const dateLabel=all(tree).find(n=>n.type==='label'&&all(n).some(c=>c.type==='span'&&c.props.children==='購入日'));all(dateLabel).find(n=>n.type==='input').props.onChange({target:{value:'2026-10-08'}});await settle();const market=all(tree).find(n=>n.type==='select'&&n.props.value==='メルカリ');market.props.onChange({target:{value:marketplace}});await settle();
function field(label){const l=all(tree).find(n=>n.type==='label'&&all(n).some(c=>c.type==='span'&&c.props.children===label));return all(l).find(n=>n.type==='input');}
assert.equal(field('購入日').props.value,marketplace==='Amazon返品'?'2026-10-08':source.purchased_at);assert.equal(field('仕入金額（円）').props.value,marketplace==='Amazon返品'?0:source.cost_amount);
assert.equal(field(marketplace==='動作品Amazon返品'?'ENA':'商品ID').props.value,source.marketplace_item_id);assert.equal(field('仕入先URL').props.value,source.marketplace_url);
}
console.log('Exact root lookup, ID/URL hydration, safe URL fallback and both return form fields passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
