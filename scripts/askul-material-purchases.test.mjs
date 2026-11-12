import assert from 'node:assert/strict';
import test from 'node:test';
import { materialPurchaseWindow, summarizeMaterialPurchases } from '../apps/admin/src/materialPurchases.ts';

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
