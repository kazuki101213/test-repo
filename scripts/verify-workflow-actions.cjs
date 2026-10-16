const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('node:assert/strict');
function moduleAt(file){const c={exports:{},require:()=>({})};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,c);return c.exports;}
const workflow=moduleAt('packages/shared/src/workflow.ts'),seller=moduleAt('packages/shared/src/seller.ts');
const base={id:'one',sku:'2407-AAMM-20261012-1000',title:'ブルーレイレコーダー',model_no:'DBR-W508',marketplace:'ヤフオク',sales_channel:'メルカリ',planned_price:15981,condition:'非常に良い',deliverer_name:'MM 株式会社吉光'};
const keys=(status,extra={})=>Array.from(workflow.deliveryWorkflowButtons({...base,status,...extra}),button=>button.key);
assert.deepEqual(keys('受取前'),[]);assert.deepEqual(keys('販売済'),[]);assert.deepEqual(keys('Amazon補填申請中'),[]);
assert.deepEqual(keys('検品中'),['inspection_complete','report']);assert.deepEqual(keys('検品中',{marketplace:'Amazon返品'}),['inspection_complete','report','return_request_cancel']);
assert.equal(workflow.deliveryWorkflowButtons({...base,status:'検品中',marketplace:'動作品Amazon返品'})[1].label,'破損報告');
assert(keys('商品登録前').includes('listing'));assert(!keys('商品登録前').includes('listing_complete'));assert(keys('商品登録前',{sales_channel:'FBA'}).includes('listing_complete'));
assert(keys('商品登録前',{workflow_decision:'yahoo'}).includes('yahoo_instruction_cancel'));assert(!keys('商品登録前',{workflow_decision:'compensated'}).includes('inspection_cancel'));
assert(!keys('動作不良').includes('supplier_return_complete'));assert(keys('動作不良',{supplier_contact_requested_at:'now'}).includes('supplier_return_complete'));
assert.deepEqual(keys('返品処理'),['supplier_return_cancel']);assert(!keys('返品処理',{marketplace:'Amazon返品'}).length);
assert(!keys('検品中',{is_accessory:true}).length);assert(keys('検品中',{is_accessory:true,sku:'2407c-AAMM-test'}).length);
assert.deepEqual(Array.from(workflow.managementWorkflowButtons('Amazon補填申請中'),x=>x.key),['send_back','compensation_complete','compensation_denied']);
const m=seller.sellerDefaults(base);assert.equal(m.price,12785);assert.equal(m.shippingMethod,'ゆうゆうメルカリ便');assert.equal(m.origin,'千葉県');assert.equal(m.dropoff,'ローソン');assert.equal(m.size,'100');
const y=seller.sellerDefaults({...base,sales_channel:'ヤフオク',deliverer_name:'コエル',condition:'可'});assert.equal(y.price,6393);assert.equal(y.shippingPayer,'購入者負担');assert.equal(y.shippingMethod,'おてがる配送（日本郵便）');assert.equal(y.auctionDays,3);assert.equal(y.closingHour,23);assert.equal(y.autoExtend,true);assert.equal(y.autoRelist,false);assert.equal(y.condition,'傷や汚れあり');
for(const [name,origin,dropoff] of [['石川秀樹','山梨県','ヤマト営業所'],['久保田ゆかり','愛媛県','セブンイレブン'],['久保田真由','愛媛県','セブンイレブン'],['土井','新潟県','セブンイレブン'],['新川','千葉県','セブンイレブン'],['吉光','千葉県','ローソン'],['コエル','埼玉県','ローソン']]){const value=seller.sellerDefaults({...base,deliverer_name:name});assert.equal(value.origin,origin);assert.equal(value.dropoff,dropoff);}
assert.equal(seller.sellerDefaults({...base,title:'液晶モニター',model_no:null}).size,'140');assert.equal(seller.sellerDefaults({...base,title:'ヘッドホン',model_no:null}).category,'小物');assert.equal(seller.sellerDefaults({...base,condition:null}).condition,'');
const parsed=seller.sellerDefaults({...base,description:'商品名（メルカリ）\n出品の商品名\n\n説明文\n説明の本文'});assert.equal(parsed.title,'出品の商品名');assert.equal(parsed.description,'説明の本文');
console.log('PASS: per-product state actions, reversals, compensation authority, exact seller presets, ceil pricing and saved listing text');
