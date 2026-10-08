const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const compile=f=>ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const model={exports:{}};vm.runInNewContext(compile('packages/shared/src/productModel.ts'),model);
const search={exports:{},require:()=>model.exports};vm.runInNewContext(compile('apps/delivery/src/deliverySearch.ts'),search);
const {deliverySearchFields,deliverySearchValue,normalizeSearch}=search.exports;
const task={id:'target',sku:'2198aa-AAII-20261007-100',lot_seq:2198,model_no:'BDZ-FBW1000',title:'X000FNSKU',asin:'B07WZK3RJR',marketplace_item_id:'ENA998',tracking_no:'X001TRACK',marketplace:'動作品Amazon返品'};
const collision={...task,id:'other',sku:'100-AAII-20261007-1',lot_seq:100,title:'2198aa',model_no:'ENA998',asin:'BDZ-FBW1000',marketplace_item_id:'X001TRACK',tracking_no:'B07WZK3RJR'};
const ids=new Map();
const matches=(row,field,query)=>normalizeSearch(deliverySearchValue(row,field,ids)).includes(normalizeSearch(query));
const checks=[['serial',' ２１９８ＡＡ '],['sku',task.sku.toLowerCase()],['model','bdz-fbw1000'],['asin','b07wzk3rjr'],['marketplace_item_id','ena998'],['tracking_no','x001track']];
assert.deepEqual(Array.from(deliverySearchFields,f=>f.label),['通番号','SKU','型番','ASIN','商品ID','追跡番号']);
for(const [field,query] of checks){assert(matches(task,field,query));assert(!matches(collision,field,query),'Other fields must not match '+field);}
assert.equal(deliverySearchValue({...task,model_no:null},'model',ids),'未登録');assert(!matches({...task,model_no:null},'model','X000FNSKU'));
ids.set(task.id,'ORIGINAL-ID');assert.equal(deliverySearchValue(task,'marketplace_item_id',ids),'ENA998');
assert.equal(deliverySearchValue({...task,marketplace:'Amazon返品'},'marketplace_item_id',ids),'ORIGINAL-ID');
assert(!matches({...task,marketplace:'Amazon返品'},'marketplace_item_id','ENA998'),'A hidden stale product ID should not match');
assert.equal(deliverySearchValue({...task,asin:null},'asin',ids),'');
assert(matches({...task,marketplace:'ヤフオク',model_no:null,title:'DBR-W1009'},'model','DBR-W1009'));
console.log('Six isolated selected fields, suffixes, normalization, displayed model/product ID and FNSKU exclusion passed');
