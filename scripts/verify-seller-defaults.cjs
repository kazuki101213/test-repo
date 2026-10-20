const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const sellerExports={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('packages/shared/src/seller.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:sellerExports});
const cases=[['石川 秀樹','山梨県','ヤマト営業所',false],['久保田 ゆかり','愛媛県','セブンイレブン',false],['久保田 真由','愛媛県','セブンイレブン',false],['土井 花菜','新潟県','セブンイレブン',false],['新川 水紀','千葉県','セブンイレブン',false],['株式会社吉光','千葉県','ローソン',true],['株式会社 コエル','埼玉県','ローソン',true]];
for(const [name,origin,place,postal] of cases)for(const channel of ['メルカリ','ヤフオク']){
 const draft=sellerExports.sellerDefaults({deliverer_name:name,sales_channel:channel,title:'BDZ-ZW1500',planned_price:20981,condition:'非常に良い'});
 assert.equal(draft.origin,origin);assert.equal(draft.dropoff,place);
 assert.equal(draft.shippingMethod,channel==='メルカリ'?(postal?'ゆうゆうメルカリ便':'らくらくメルカリ便'):(postal?'おてがる配送（日本郵便）':'おてがる配送（ヤマト運輸）'));
 assert.equal(draft.price,Math.ceil(20981*(channel==='メルカリ'?.8:.3)));assert.equal(draft.size,'100');
}
console.log('Seven staff shipping defaults and channel prices passed');
for(const [title,category,weight] of [['リモコン','小物','2'],['ブルーレイレコーダー BDZ-ZW1500','ブルーレイレコーダー','5'],['液晶テレビ','テレビ','5'],['液晶モニター','モニター','5']]){
 for(const channel of ['ヤフオク','メルカリ']){const draft=sellerExports.sellerDefaults({title,sales_channel:channel});assert.equal(draft.category,category);assert.equal(draft.weightKg,channel==='ヤフオク'?weight:undefined);}
}
console.log('Yahoo packed weight: small 2kg, other categories 5kg; Mercari unchanged');

for(const [planned,expected] of [[30000,9000],[20981,6295],[1,1],[0,0]]){
 assert.equal(sellerExports.sellerDefaults({sales_channel:'ヤフオク',planned_price:planned}).price,expected);
}
console.log('Yahoo starts at 30 percent, rounded up to the next yen');
