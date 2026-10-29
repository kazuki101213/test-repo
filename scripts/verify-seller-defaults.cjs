const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const categoryExports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/productCategory.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:categoryExports});
const sellerExports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/seller.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:sellerExports,require:()=>categoryExports});
const cases=[['石川 秀樹','山梨県','ヤマト営業所',false],['久保田 ゆかり','愛媛県','セブンイレブン',false],['久保田 真由','愛媛県','セブンイレブン',false],['土井 花菜','新潟県','セブンイレブン',false],['新川 水紀','千葉県','セブンイレブン',false],['株式会社吉光','千葉県','ローソン',true],['株式会社 コエル','埼玉県','ローソン',true]];
for(const [name,origin,place,postal] of cases)for(const channel of ['メルカリ','ヤフオク']){
 const draft=sellerExports.sellerDefaults({deliverer_name:name,sales_channel:channel,title:'BDZ-ZW1500',planned_price:20981,condition:'非常に良い'});
 assert.equal(draft.dispatchDays,channel==='メルカリ'?'4〜7日':'2〜3日');assert.equal(draft.origin,origin);assert.equal(draft.dropoff,place);
 assert.equal(draft.shippingMethod,channel==='メルカリ'?(postal?'ゆうゆうメルカリ便':'らくらくメルカリ便'):(postal?'おてがる配送（日本郵便）':'おてがる配送（ヤマト運輸）'));
 assert.equal(draft.price,Math.ceil(20981*(channel==='メルカリ'?.8:.35)));assert.equal(draft.size,'100');
}
console.log('Seven staff shipping defaults and channel prices passed');
for(const [title,category,weight] of [['リモコン','小物','2'],['ブルーレイレコーダー BDZ-ZW1500','ブルーレイレコーダー','5'],['BDP-S6700','ブルーレイレコーダー','5'],['UBP-X700','ブルーレイレコーダー','5'],['液晶テレビ','テレビ','5'],['液晶モニター','モニター','5']]){
 for(const channel of ['ヤフオク','メルカリ']){const draft=sellerExports.sellerDefaults({title,sales_channel:channel});assert.equal(draft.category,category);assert.equal(draft.weightKg,channel==='ヤフオク'?weight:undefined);}
}
console.log('Yahoo packed weight: small 2kg, other categories 5kg; Mercari unchanged');

for(const condition of ['ほぼ新品','非常に良い','良い','可',null]){
 const expected=condition==='可'?6000:10500;
 assert.equal(sellerExports.sellerDefaults({sales_channel:'ヤフオク',planned_price:30000,condition}).price,expected);
}
for(const [planned,condition,expected] of [[20981,'可',4197],[20981,'非常に良い',7344],[1,'可',1],[1,'良い',1],[0,'可',0],[0,'良い',0]]){
 assert.equal(sellerExports.sellerDefaults({sales_channel:'ヤフオク',planned_price:planned,condition}).price,expected);
}
console.log('Yahoo: acceptable 20 percent, all others 35 percent, rounded up; Mercari unchanged');
// Product numbers and titles may change; model classification must remain stable.
for(const [model,expected] of [['TT-4K100','ブルーレイレコーダー'],['DP-UB45','ブルーレイレコーダー'],['UBP-X700','ブルーレイレコーダー'],['VZ239HR','モニター'],['XL2546X','モニター'],['P2418HT','モニター'],['G2524H','モニター'],['24UD58','モニター'],['32SR73U','モニター'],['BenQ DP1310','小物'],['WD19S','小物'],['SRF-R356','小物'],['Aprica ラクリス','小物'],['UNKNOWN-MODEL','小物']]){
 for(const product_no of [1,219,999]){
  const draft=sellerExports.sellerDefaults({model_no:model,title:'ブルーレイ',product_no,sales_channel:'メルカリ'});
  assert.equal(draft.category,expected,model);
 }
}
assert.equal(sellerExports.sellerDefaults({model_no:'ｕｂｐ－ｘ７００',title:'',sales_channel:'メルカリ'}).category,'ブルーレイレコーダー');
assert.equal(sellerExports.sellerDefaults({title:'SONY UBP-X700 本体',sales_channel:'メルカリ'}).category,'ブルーレイレコーダー');
console.log('Catalog model categories survive renumbering, title changes and full-width input');

for(const [method,bad,expected] of [['ゆうゆうメルカリ便','セブンイレブン','ローソン'],['ゆうゆうメルカリ便','ヤマト営業所','ローソン'],['らくらくメルカリ便','ローソン','ヤマト営業所']]){
 const draft=sellerExports.sellerShippingDraft(sellerExports.sellerDefaults({title:'BD-WW1200',deliverer_name:'土井',sales_channel:'メルカリ'}),{shippingMethod:method,dropoff:bad});
 assert(sellerExports.sellerShippingPlaces(method).includes(draft.dropoff));if(method==='ゆうゆうメルカリ便')assert.equal(draft.dropoff,expected);
}
for(const dropoff of ['ローソン','郵便局']){
 const draft=sellerExports.sellerShippingDraft(sellerExports.sellerDefaults({title:'BD-WW1200',sales_channel:'メルカリ'}),{shippingMethod:'ゆうゆうメルカリ便',dropoff});
 assert.equal(draft.dropoff,dropoff);
}
console.log('Saved postal shipping methods cannot inherit Yamato/Seven drop-offs');
// Both carrier directions must reject cross-carrier packages and stores.
for(const [method,size,place] of [['らくらくメルカリ便','宅急便コンパクト','セブンイレブン'],['ゆうゆうメルカリ便','ゆうパケットプラス','ローソン'],['ゆうゆうメルカリ便','ゆうパケットプラス','郵便局']]) assert.equal(sellerExports.sellerShippingError({shippingMethod:method,size,dropoff:place}),'');
for(const [method,size,place] of [['らくらくメルカリ便','ゆうパケットプラス','セブンイレブン'],['ゆうゆうメルカリ便','宅急便コンパクト','ローソン'],['らくらくメルカリ便','宅急便コンパクト','ローソン'],['ゆうゆうメルカリ便','ゆうパケットプラス','セブンイレブン']]) assert.notEqual(sellerExports.sellerShippingError({shippingMethod:method,size,dropoff:place}),'');
for(const [method,size] of [['らくらくメルカリ便','ゆうパケットプラス'],['ゆうゆうメルカリ便','宅急便コンパクト']]) assert.equal(sellerExports.sellerShippingDraft(sellerExports.sellerDefaults({sales_channel:'メルカリ'}),{shippingMethod:method,size}).size,'');
assert(!sellerExports.sellerShippingSizes('らくらくメルカリ便').includes('ゆうパケットプラス'));
assert(!sellerExports.sellerShippingSizes('ゆうゆうメルカリ便').includes('宅急便コンパクト'));
console.log('Shipping compatibility: both carrier directions, stores, and invalid saved package require reselection');

for(const model of ['BDP-S6700','UBP-X700','ｂｄｐ－ｓ６７００']){const draft=sellerExports.sellerDefaults({title:model,model_no:model,sales_channel:'ヤフオク'});assert.equal(draft.listingCategory,'ブルーレイレコーダー > ソニー');assert.equal(sellerExports.sellerListingCategoryError(draft,'ヤフオク'),'');}
for(const manufacturer of ['SONY','Panasonic','東芝']){const draft=sellerExports.sellerDefaults({title:'ブルーレイレコーダー',model_no:'TT-4K100',sales_channel:'ヤフオク'},manufacturer);assert(draft.listingCategory.includes(' > '));assert.equal(sellerExports.sellerListingCategoryError(draft,'ヤフオク'),'');}
const unknown={category:'ブルーレイレコーダー',listingCategory:'ブルーレイレコーダー'};assert.match(sellerExports.sellerListingCategoryError(unknown,'ヤフオク'),/メーカーまで指定/);assert.equal(sellerExports.sellerListingCategoryError(unknown,'メルカリ'),'');
console.log('Yahoo manufacturer category defaults and pre-submit parent guard passed');
