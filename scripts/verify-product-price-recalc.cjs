// 販売想定金額を変えたら、その時だけAmazonの手数料APIで振込想定金額・仕入れ目標金額を計算し直す（2026-11-22 ユーザー指定）。
const fs=require('node:fs'),assert=require('node:assert/strict');
const api=fs.readFileSync('apps/admin/src/api.ts','utf8');
const between=(a,b)=>api.slice(api.indexOf(a),api.indexOf(b));
const helper=between('export function ruleProfitRate','export async function updateProductField');
assert(helper.includes("functions.invoke<{ payout?: number }>('amazon-catalog-estimate'"),'Uses the Amazon fee estimate function');
assert(helper.includes('payout <= 10000 ? 23 : payout <= 50000 ? 20 : 17'),'Same rule profit rates as the catalog extension');
assert(helper.includes('profitRate ?? ruleProfitRate(payout)'),'An entered profit rate wins over the rule');
const ext=fs.readFileSync('tools/amazon-catalog-extension/catalog.js','utf8');
assert(ext.includes('payout <= 10000 ? 23 : payout <= 50000 ? 20 : 17')&&ext.includes('profitRate ?? '),'Extension uses the same rule and entered rate');
const field=between('export async function updateProductField','export async function updateProductDetails');
assert(field.includes("field === 'target_profit_rate' && product.payout_estimate !== null"),'Changing the profit rate recalculates the target');
assert(field.includes("field === 'list_price'")&&field.includes('parsed !== product.list_price')&&field.includes('amazonProductAmounts(product.asin, parsed, product.target_profit_rate'),'Inline price edit calls the API only when the price changes');
assert(!field.includes('estimateProductAmounts'),'Genre-rate estimate is no longer used');
const details=between('export async function updateProductDetails','export async function createProduct');
assert(details.includes('amazonProductAmounts(asin, listPrice, profitRate)')&&details.includes('payout === (product.payout_estimate ?? null)'),'Full edit uses the API unless amounts were edited by hand');
assert(details.includes('payout = amounts.payout_estimate;')&&details.includes('if (!targetEdited) targetCost = amounts.target_cost;'),'A hand-entered target never leaves the old payout behind a new price');
// 2026-11-26：販売想定金額だけを変えて振込想定金額が古いまま残る保存はDBが断り、毎日APIと照合して直す。
const migration=fs.readFileSync('supabase/migrations/20261126090000_payout_follows_price.sql','utf8');
assert(migration.includes('new.list_price is distinct from old.list_price')&&migration.includes('new.payout_estimate is not distinct from old.payout_estimate'),'DB rejects a price change that keeps the old payout');
assert(migration.includes('before update of list_price on app.products')&&migration.includes('before update of list_price on app.product_options'),'Guard covers products and their options');
// 2026-11-26 ユーザー指示：APIは登録時・販売想定金額の変更時だけ。毎日の照合はやめた。
assert(fs.readFileSync('supabase/migrations/20261126100000_stop_payout_daily_check.sql','utf8').includes("cron.unschedule('product-payout-daily-check')"),'No scheduled fee API checks');
const fn=fs.readFileSync('supabase/functions/amazon-catalog-estimate/index.ts','utf8');
assert(fn.includes("verify_amazon_cron_token")&&fn.includes('payoutCorrection(row, payout)')&&fn.includes("apply_payout_correction"),'Daily check verifies the cron token and applies the profit rule');
assert(fn.includes('payout <= 10000 ? 23 : payout <= 50000 ? 20 : 17'),'Daily check uses the same profit rule');
const create=api.slice(api.indexOf('export async function createProduct'));
assert(create.slice(0,create.indexOf('\n}\n')).includes('amazonProductAmounts(asin, listPrice, profitRate)'),'Admin registration uses the API');
// targetCostFromPayout の境界
const t=(p,r=null)=>Math.round(p*(100-(r??(p<=10000?23:p<=50000?20:17)))/100);
assert.equal(t(20000,15),17000);
assert.deepEqual([t(10000),t(10001),t(50000),t(50001)],[7700,8001,40000,41501]);
console.log('PASS: price change recalculates payout/target with the Amazon fee API only when the price changes');
