import assert from 'node:assert/strict';
import test from 'node:test';
import { materialPurchaseWindow, summarizeBubbleWrap, summarizeMaterialPurchases } from '../apps/admin/src/materialPurchases.ts';

test('compares net quantities only within the same staff and material group', () => {
  const row = (date, quantity, staff = 'A', item = 'テープＡ', name = 'テープ') => ({
    incurred_on: date, name, staff_id: staff, amount: 100 * quantity, askul_item: item, askul_quantity: quantity,
  });
  const rows = summarizeMaterialPurchases([
    row('2025-10-04', 2), row('2025-11-05', 4), row('2025-09-05', 900),
    row('2026-01-02', 6, 'A', 'テープA'), row('2026-01-03', -1),
    row('2026-01-04', 7, 'B'), row('2026-01-04', 2, null), row('2026-02-01', 900),
  ], '2026-01', 150);
  assert.deepEqual(materialPurchaseWindow('2026-01'), { from: '2025-10-01', until: '2026-02-01' });
  assert.deepEqual(rows.map(({ staffId, quantity, amount, averageQuantity, increased }) =>
    [staffId, quantity, amount, averageQuantity, increased]), [
    ['A', 5, 500, 3, true], ['B', 7, 700, null, false], [null, 2, 200, null, false],
  ]);
});

test('compares only same-month buyers with completed work, weighted by the other staff’s workloads', () => {
  const row = (staff, qty, item = 'テープ', incurred_on = '2026-11-10') => ({
    incurred_on, name: item, staff_id: staff, amount: qty * 100, askul_item: item, askul_quantity: qty,
  });
  const workload = new Map([['A', 4], ['B', 8], ['C', 2], ['E', 1], ['F', 20]]
    .map(([staff, completedItems]) => [staff, { completedItems, recorderItems: 0 }]));
  const results = summarizeMaterialPurchases([
    row('A', 8), row('B', 4), row('C', 2), row('D', 100), row('E', 4, '別のテープ'),
    row('F', 100, 'テープ', '2026-10-10'),
  ], '2026-11', 150, workload);
  assert.deepEqual(results.map(r => [r.staffId, r.quantityPerItem, r.peerQuantityPerItem, r.peerCount, r.abovePeers]), [
    ['A', 2, 0.6, 2, true], ['D', null, null, 0, false], ['B', 0.5, 10 / 6, 2, false],
    ['E', 4, null, 0, false], ['C', 1, 1, 2, false],
  ]);
});

test('converts purchased bubble-wrap rolls to metres and estimates four metres per recorder', () => {
  const row = (staff_id, askul_quantity, askul_item) => ({
    incurred_on: '2026-11-10', name: askul_item, staff_id, amount: 0, askul_item, askul_quantity,
  });
  const workload = new Map([['A', 6], ['B', 2], ['C', 1]].map(([id, recorderItems]) =>
    [id, { completedItems: 9, recorderItems }]));
  assert.deepEqual(summarizeBubbleWrap([
    row('A', 2, 'プチプチ 幅６００ｍｍ×４２ｍ巻 １巻'),
    row('A', -1, '気泡緩衝材 5.5m 2巻'),
    row('A', 3, 'OPPテープ 50m 10巻'),
    row('B', 1, 'エアキャップ 40mm'),
  ], '2026-11', workload), [
    { staffId: 'A', recorderItems: 6, estimatedMetres: 24, purchasedMetres: 73, hasPurchase: true },
    { staffId: 'B', recorderItems: 2, estimatedMetres: 8, purchasedMetres: null, hasPurchase: true },
    { staffId: 'C', recorderItems: 1, estimatedMetres: 4, purchasedMetres: null, hasPurchase: false },
  ]);
});
