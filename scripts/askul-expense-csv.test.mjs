import assert from 'node:assert/strict';
import test from 'node:test';
import { findAskulDeliveryAssignee, parseAskulExpenseCsv, parseAskulExpenseReport } from '../packages/shared/src/askulCsv.ts';

const headers = '注文先サプライヤ名,出荷日,出荷オーダーNo,出荷オーダー行No,注文時商品名,出荷数量,小計金額（税込）,値引額（税込）,税率,経費区分';
const purchase = `アスクル,2026/11/10,'74439335,'1,"梱包材, ""透明""",1,"1,020",100,0.1,1`;
const fee = `アスクル,2026/11/10,'74439335,'2,送料,1,220,0,0.1,3`;
const refund = `アスクル,2026/11/10,'R74439335,'1,返品,-1,-1020,-100,0.1,1`;
const parse = rows => parseAskulExpenseCsv(new TextEncoder().encode([headers, ...rows, ''].join('\r\n')).buffer);

test('preserves ASKUL subtotals, distinct fees and signed returns across repeat downloads', async () => {
  const rows = await parse([purchase, fee, refund]);
  assert.deepEqual(rows.map(row => row.amount), [1020, 220, -1020]);
  assert.deepEqual(rows.map(row => row.askul_quantity), [1, null, -1]);
  assert.deepEqual(rows.map(row => row.askul_item), ['梱包材, "透明"', null, '返品']);
  assert.equal(rows[0].name, '梱包材, "透明"');
  assert.equal(rows[0].incurred_on, '2026-11-10');
  assert.equal(rows[0].category, '変動費');
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  const reordered = await parse([refund, purchase, fee]);
  assert.deepEqual(reordered.map(row => row.id), [rows[2].id, rows[0].id, rows[1].id]);
});

test('fails the whole CSV before import for duplicate source rows or an invalid date', async () => {
  await assert.rejects(parse([purchase, purchase]), /重複/);
  await assert.rejects(parse([fee.replace('11/10', '11/31')]), /出荷日/);
});

test('uses all three address columns for an unambiguous match without adding the address to the expense', async () => {
  const addressColumns = '注文時お届け先住所1,注文時お届け先住所2,注文時お届け先住所3';
  const bytes = new TextEncoder().encode(headers + ',' + addressColumns + '\r\n'
    + purchase + ",東京都千代田区,'丸の内１丁目２番３号,見本ビル\r\n").buffer;
  const report = await parseAskulExpenseReport(bytes);
  const address = report.deliveryAddresses[0];
  const profile = { staff_id: 'staff-a', address: '〒100-0000 東京都千代田区丸の内1-2-3 見本ビル' };
  assert.equal(findAskulDeliveryAssignee(address, [profile]), 'staff-a');
  assert.equal(findAskulDeliveryAssignee(address, [profile, { ...profile, staff_id: 'staff-b' }]), null);
  assert.equal(findAskulDeliveryAssignee(address, [{ ...profile, address: '東京都千代田区丸の内1-2-3 別ビル' }]), null);
  assert.equal(report.rows[0].staff_id, null);
  assert.equal(report.rows[0].id, (await parse([purchase]))[0].id);
  assert.ok(!JSON.stringify(report.rows).includes('千代田区'));
  await assert.rejects(parseAskulExpenseReport(new TextEncoder().encode(headers + ',注文時お届け先住所1\n' + purchase + ',東京都').buffer), /住所1・2・3/);
});
