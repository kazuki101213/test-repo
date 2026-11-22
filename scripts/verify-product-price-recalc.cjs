// 販売想定金額を変えたら振込想定金額・仕入れ目標金額も直す（2026-11-22 ユーザー指定）。
const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/productEstimates.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
assert.deepEqual({...ctx.exports.estimateProductAmounts('パソコン・周辺機器',27980)},{payout_estimate:25742,target_cost:19564});
const api=fs.readFileSync('apps/admin/src/api.ts','utf8');
const field=api.slice(api.indexOf('export async function updateProductField'),api.indexOf('export async function updateProductDetails'));
assert(/field === 'list_price' \|\| field === 'genre'/.test(field)&&field.includes('estimateProductAmounts('),'Inline price/genre edit recalculates');
const details=api.slice(api.indexOf('export async function updateProductDetails'),api.indexOf('export async function createProduct'));
assert(details.includes('estimateProductAmounts(input.genre.trim(), listPrice)')&&details.includes('payout === (product.payout_estimate ?? null)'),'Full edit recalculates unless amounts were edited by hand');
console.log('PASS: changing the expected sale price recalculates payout and target cost');
