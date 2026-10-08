const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const inventory={exports:{}};vm.runInNewContext(compile('apps/admin/src/inventory.ts'),inventory);
const shared={productModelText:i=>i.model_no||i.title||'未登録',staffDisplayName:s=>s||'',deliveryStaffOptions:s=>s,STATUSES:['作業中','販売済'],CONDITIONS:[],MARKETPLACES:['Amazon返品','動作品Amazon返品'],SALES_CHANNELS:['FBA','自己発送'],jpDate:s=>s||'—',yen:n=>String(n??'—')};
const stateConstants={exports:{}};vm.runInNewContext(compile('packages/shared/src/constants.ts'),stateConstants);const stateSearch={exports:{},require:()=>stateConstants.exports};vm.runInNewContext(compile('packages/shared/src/stateSearch.ts'),stateSearch);Object.assign(shared,stateSearch.exports);
const filters={exports:{},require:name=>name==='@bussan/shared'?shared:inventory.exports};vm.runInNewContext(compile('apps/admin/src/inventoryFilters.ts'),filters);
const search={exports:{},require:name=>name==='@bussan/shared'?shared:inventory.exports};vm.runInNewContext(compile('apps/admin/src/inventorySearch.ts'),search);
const row={id:'1',sku:'2204-AAII-20261007-100',lot_seq:2204,is_accessory:false,title:'body',model_no:'MODEL',purchaser_name:'AA',deliverer_name:'II',asin:'B000000001',cost_amount:1000,amazon_refund_amount:-1234,non_amazon_refund_amount:0,inventory_refund_amount:0,purchased_at:'2026-10-07',memo:'購入者コメント\n続き',latest_comment:'納品者コメント',status:'作業中',sales_channel:'FBA',planned_price:2000,expected_profit:400,product_sold_price:null,product_profit:null};
const rows=[row,{...row,id:'2',sku:'2204-AAII-20260901-123',is_accessory:true,title:'remote',cost_amount:1230,sold_price:200,payout_amount:150,product_sold_price:9999,product_payout_amount:8888},{...row,id:'3',sku:'2277b-AAII-20261007-100',lot_seq:2277,cost_amount:2000,amazon_refund_amount:0,purchased_at:null}];
const f=(values=null,from='',to='')=>({values,from,to});const apply=filters.exports.filterInventoryColumns;
assert.equal(apply(rows,{amazon_refund:f(null,'-2000','-1')}).length,2);
assert.equal(apply(rows,{cost:f(null,'1000','1230'),registration:f(['本体'])}).length,1);
assert.equal(apply(rows,{serial:f(['2277b'])}).length,1);
assert.equal(apply(rows,{purchased_at:f(null,'2026-10-07','2026-10-07')}).length,2);
assert.equal(apply(rows,{purchased_at:f([''])}).length,1);
assert.equal(apply(rows,{status:f([])}).length,0);
assert.equal(apply(rows,{}),rows);
assert.equal(apply(Array.from({length:1001},(_,i)=>({...row,id:String(i),sku:`${i}-AAII-20261007-100`,lot_seq:i})),{serial:f(['1000'])}).length,1);
assert.equal(Object.keys(filters.exports.inventoryColumns).length,34);
assert.equal(search.exports.matchesInventorySearch({...row,marketplace:'動作品Amazon返品'},'state','marketplace:Amazon返品'),false);
assert.equal(search.exports.matchesInventorySearch({...row,marketplace:'Amazon返品'},'state','marketplace:Amazon返品'),true);
assert.equal(search.exports.matchesInventorySearch({...row,sales_channel:'FBA'},'state','sales_channel:FBA'),true);
assert.equal(search.exports.matchesInventorySearch({...row,sales_channel:'自己発送'},'state','sales_channel:FBA'),false);
const accessory=rows[1];
assert.equal(filters.exports.inventoryColumns.sold_price.value(accessory),200);
assert.equal(filters.exports.inventoryColumns.payout.value(accessory),150);
for(const value of [null,0]) {
 assert.equal(filters.exports.salePrice({...accessory,sold_price:value}),value);
 assert.equal(filters.exports.salePayout({...accessory,payout_amount:value}),value);
}
assert.equal(filters.exports.salePrice({...row,product_sold_price:9999}),9999);
assert.equal(filters.exports.salePayout({...row,product_payout_amount:8888}),8888);
assert.equal(apply(rows,{sold_price:f(['200'])})[0].id,'2');
let cursor=0,dirty=true,pending=[],tree,lastRequest;const hooks=[];
const react={useState(v){const i=cursor++;if(!hooks[i])hooks[i]={value:typeof v==='function'?v():v};return[hooks[i].value,n=>{hooks[i].value=typeof n==='function'?n(hooks[i].value):n;dirty=true;}];},useRef(v){return hooks[cursor++]??={current:v};},useMemo(fn,deps){const i=cursor++,h=hooks[i];if(!h||deps.some((d,j)=>d!==h.deps[j]))hooks[i]={value:fn(),deps};return hooks[i].value;},useCallback(fn,deps){return this.useMemo(()=>fn,deps);},useEffect(fn,deps){const i=cursor++,h=hooks[i];if(!h||deps.some((d,j)=>d!==h.deps[j])){h?.cleanup?.();const next=hooks[i]={deps};pending.push(()=>{next.cleanup=fn();});}}};
// Hook methods are imported as standalone functions.
react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
const jsx=(type,props)=>({type,props});const api={fetchItems:async q=>{lastRequest=q;return{items:rows,count:2};},fetchStaff:async()=>[],fetchPurchaseDrafts:async()=>[]};
const context={exports:{},require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@bussan/shared'?shared:name==='../api'?api:name==='../inventory'?inventory.exports:name==='../inventoryFilters'?filters.exports:name==='../inventorySearch'?search.exports:{default:name.includes('InventoryColumnFilter')?'popup':'component'},AbortController,Date,Set,URL,Intl,window:{setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}}};
vm.runInNewContext(compile('apps/admin/src/pages/Inventory.tsx'),context);
function render(){cursor=0;dirty=false;tree=context.exports.default({me:{role:'admin',id:'AA'}});pending.splice(0).forEach(fn=>fn());}
async function settle(){for(let i=0;i<12;i++){if(dirty)render();await Promise.resolve();}}
function all(n,out=[]){if(!n||typeof n!=='object')return out;if(Array.isArray(n)){n.forEach(v=>all(v,out));return out;}out.push(n);all(n.props?.children,out);return out;}
(async()=>{
 await settle();
 const commentHeadings=all(tree).filter(n=>n.type==='button'&&['仕入担当者からのコメントのフィルター','納品担当者からのコメントのフィルター'].includes(n.props['aria-label']));assert.equal(commentHeadings[0].props['aria-label'],'仕入担当者からのコメントのフィルター');
 const commentButtons=all(tree).filter(n=>n.type==='button'&&n.props.className==='inventory-comment');assert.equal(commentButtons.length,6);
 commentButtons[0].props.onClick();await settle();assert(all(tree).some(n=>n.type==='p'&&n.props.children===row.memo));
 all(tree).find(n=>n.type==='button'&&n.props.children==='閉じる').props.onClick();await settle();
 commentButtons[1].props.onClick();await settle();assert(all(tree).some(n=>n.type==='p'&&n.props.children===row.latest_comment));
 all(tree).find(n=>n.type==='button'&&n.props.children==='閉じる').props.onClick();await settle();
 const selector=()=>all(tree).find(n=>n.props?.['aria-label']==='検索項目');
 assert.equal(selector().props.value,'serial');
 assert.deepEqual(all(selector()).filter(n=>n.type==='option').map(n=>n.props.children),['通番号','SKU','型番','ASIN','商品ID','追跡番号','状態']);
 assert(!all(tree).some(n=>n.type==='details'&&n.props.className==='inventory-filter-dropdown'));
 for(const field of search.exports.inventorySearchFields){selector().props.onChange({target:{value:field.value}});await settle();assert.equal(lastRequest.queryField,field.value);if(field.value==='state'){const target=all(tree).find(n=>n.props?.['aria-label']==='状態で検索');assert(target);assert.deepEqual(all(target).filter(n=>n.type==='optgroup').map(n=>n.props.label),['仕入先','販売先','販売状態']);for(const value of ['marketplace:Amazon返品','sales_channel:FBA','status:作業中','']){target.props.onChange({target:{value}});await settle();assert.equal(lastRequest.query,value||undefined);}}else assert.equal(all(tree).find(n=>n.props?.['aria-label']==='在庫を検索').props.placeholder,'検索');}
 const accessoryRow=all(tree).find(n=>n.type==='tr'&&all(n).some(c=>c.type==='button'&&c.props.children===accessory.sku));
 const saleCell=all(accessoryRow).filter(n=>n.type==='td')[11];
 const moneyButtons=all(saleCell).filter(n=>n.type==='button');
 assert.deepEqual(moneyButtons.map(n=>n.props.children),['200','150']);
 moneyButtons[0].props.onClick();await settle();
 const editor=all(tree).find(n=>n.props?.field==='sold_price');
 assert.equal(editor.props.item.sold_price,200);assert.equal(editor.props.item.payout_amount,150);
 editor.props.onClose();await settle();
 all(accessoryRow).find(n=>n.props?.className==='inventory-photo').props.onClick();await settle();
 const fullEditor=all(tree).find(n=>n.props?.item?.id==='2'&&n.props.onClose&&!n.props.field);
 assert.equal(fullEditor.props.item.sold_price,200);assert.equal(fullEditor.props.item.payout_amount,150);
 fullEditor.props.onClose();await settle();
 const heading=all(tree).find(n=>n.props?.['aria-label']==='Amazon返金金額のフィルター');assert(heading);
 heading.props.onClick({currentTarget:{}});await settle();all(tree).find(n=>n.type==='popup').props.onApply(f(null,'-2000','-1'));await settle();
 assert.equal(all(tree).find(n=>n.type==='table'&&n.props.className==='inventory-table').props['aria-rowcount'],3);
 all(tree).find(n=>n.props?.['aria-label']==='Amazon返金金額のフィルター').props.onClick({currentTarget:{}});await settle();all(tree).find(n=>n.type==='popup').props.onApply(f([]));await settle();
 assert.equal(all(tree).find(n=>n.type==='table'&&n.props.className==='inventory-table').props['aria-rowcount'],1,'Keep headings with zero matching rows');
 selector().props.onChange({target:{value:'serial'}});await settle();
 all(tree).find(n=>n.props?.['aria-label']==='在庫を検索').props.onChange({target:{value:'search'}});await settle();
 all(tree).find(n=>n.type==='button'&&n.props.children==='フィルターをすべて解除').props.onClick();await settle();
 assert.equal(lastRequest.queryField,'serial');assert.equal(selector().props.value,'serial');
 assert.equal(lastRequest.query,undefined);assert.equal(lastRequest.statuses,undefined);assert.equal(lastRequest.delivererIds,undefined);assert.equal(lastRequest.purchasedFrom,'');assert.equal(lastRequest.purchasedTo,'');
 assert.equal(all(tree).find(n=>n.type==='table'&&n.props.className==='inventory-table').props['aria-rowcount'],4);
 console.log('34 headings, combined filters, signed ranges, dates, empty values, all fetched rows, zero-match recovery and clear-all UI passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
