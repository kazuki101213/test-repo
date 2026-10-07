const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,requires={}){const c={exports:{},require:n=>requires[n]??{},Map,Set,Date,Intl};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,c);return c.exports;}
const inventory=load('apps/admin/src/inventory.ts'),model=load('packages/shared/src/productModel.ts');
const search=load('apps/admin/src/inventorySearch.ts',{'@bussan/shared':model,'./inventory':inventory});
const base={id:'target',sku:'2198b-AAII-20260927-100',lot_seq:2198,title:'legacy title',model_no:'BDZ-FBW1000',asin:'B07WZK3RJR',tracking_no:'ヤマト12345',marketplace:'動作品Amazon返品',is_accessory:false,purchased_at:'2026-09-27'};
const target={...base,marketplace_item_id:'ENA998'},collision={...base,id:'collision',sku:'100-AAII-20261007-1',lot_seq:100,title:'2198b',model_no:'ENA998',asin:'BDZ-FBW1000',tracking_no:'B07WZK3RJR',marketplace_item_id:'ヤマト12345'};
const checks=[['serial',' 2198B '],['sku',base.sku.toLowerCase()],['model','bdz-fbw1000'],['asin','b07wzk3rjr'],['marketplace_item_id','ena998'],['tracking_no','ヤマト12345']];
for(const [field,value] of checks){assert(search.matchesInventorySearch(target,field,value));assert(!search.matchesInventorySearch(collision,field,value),'A different field must not match '+field);}
assert(!search.matchesInventorySearch({...target,model_no:null,title:'X000FNSKU'},'model','X000FNSKU'));
assert(search.matchesInventorySearch({...target,is_accessory:true,title:'リモコン'},'model','リモコン'));
assert(!search.matchesInventorySearch({...target,tracking_no:null},'tracking_no','null'));
assert(search.matchesInventorySearch(target,'serial','  '));
const filler=Array.from({length:1001},(_,n)=>({...base,id:String(n),sku:`${n+5000}-AAII-20261007-1`,lot_seq:n+5000,title:'filler',model_no:null,asin:null,tracking_no:null,marketplace_item_id:null}));
const rows=[...filler,base,collision],refs=[...filler.map(x=>({id:x.id,marketplace_item_id:null})),{id:base.id,marketplace_item_id:'ENA998'},{id:collision.id,marketplace_item_id:collision.marketplace_item_id}];
let fail=false;
const supabase={from(table){let start=0,end=499;const filters=[];const q={select(){return q},order(){return q},range(a,b){start=a;end=b;return q},gte(f,v){filters.push(x=>x[f]>=v);return q},lte(f,v){filters.push(x=>x[f]<=v);return q},abortSignal(){return q},then(resolve){return Promise.resolve(fail&&start>=500?{data:null,error:new Error('cancelled')}: {data:(table==='items'?refs:rows).filter(x=>filters.every(f=>f(x))).slice(start,end+1),error:null}).then(resolve)}};return q;}};
const api=load('apps/admin/src/api.ts',{'@bussan/shared':{getSupabase:()=>supabase},'./inventory':inventory,'./inventorySearch':search});
(async()=>{for(const [field,value]of checks){const r=await api.fetchItems({queryField:field,query:value});assert.equal(r.count,1);assert.equal(r.items.length,1);assert.equal(r.items[0].id,base.id);assert.equal(r.items[0].marketplace_item_id,'ENA998');}
const range=await api.fetchItems({queryField:'serial',query:'2198b',purchasedFrom:'2026-10-01'});assert.equal(range.items.length,0);
assert.equal((await api.fetchItems({queryField:'serial',query:''})).items.length,1003);
fail=true;await assert.rejects(api.fetchItems({queryField:'serial',query:'2198b'}),/cancelled/);
console.log('All six selected fields, suffix/case/whitespace, displayed models, correct item IDs, 1000+ rows, date intersection and failed later batch passed');})();
