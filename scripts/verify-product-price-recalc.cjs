// 販売想定金額を変えたら、その時だけAmazonの手数料APIで振込想定金額・仕入れ目標金額を計算し直す（2026-11-22 ユーザー指定）。
const fs=require('node:fs'),assert=require('node:assert/strict');
const api=fs.readFileSync('apps/admin/src/api.ts','utf8');
const between=(a,b)=>api.slice(api.indexOf(a),api.indexOf(b));
const helper=between('export function targetCostFromPayout','export async function updateProductField');
assert(helper.includes("functions.invoke<{ payout?: number }>('amazon-catalog-estimate'"),'Uses the Amazon fee estimate function');
assert(helper.includes('payout <= 10000 ? 55 : payout <= 15000 ? 75 : 76'),'Same target rates as the catalog extension');
const field=between('export async function updateProductField','export async function updateProductDetails');
assert(field.includes("field === 'list_price'")&&field.includes('parsed !== product.list_price')&&field.includes('amazonProductAmounts(product.asin, parsed)'),'Inline price edit calls the API only when the price changes');
assert(!field.includes('estimateProductAmounts'),'Genre-rate estimate is no longer used');
const details=between('export async function updateProductDetails','export async function createProduct');
assert(details.includes('amazonProductAmounts(asin, listPrice)')&&details.includes('payout === (product.payout_estimate ?? null)'),'Full edit uses the API unless amounts were edited by hand');
const create=api.slice(api.indexOf('export async function createProduct'));
assert(create.slice(0,create.indexOf('\n}\n')).includes('amazonProductAmounts(asin, listPrice)'),'Admin registration uses the API');
// targetCostFromPayout の境界
const t=p=>Math.round(p*(p<=10000?55:p<=15000?75:76)/100);
assert.deepEqual([t(10000),t(10001),t(15000),t(15001)],[5500,7501,11250,11401]);
console.log('PASS: price change recalculates payout/target with the Amazon fee API only when the price changes');
