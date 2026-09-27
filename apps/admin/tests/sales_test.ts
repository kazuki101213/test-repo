import { dailySales, groupProducts, type SaleRow } from '../src/sales.ts';
const row = (patch: Partial<SaleRow> = {}): SaleRow => ({ id: 'a', lot_seq: 1, is_accessory: false, cost_amount: 100,
  sold_on: '2026-09-01', sold_price: 1000, payout_amount: 850, ...patch });
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
}
Deno.test('same lot keeps both rows and sums purchase costs once', () => {
  const g = groupProducts([row(), row({ id: 'b', is_accessory: true, cost_amount: 50, sold_price: 0, payout_amount: 0 })]).get(1)!;
  equal(g.ids.length, 2); equal(g.cost, 150); equal(g.sale?.sold_price, 1000);
  equal(dailySales([g], '2026-09').days[0], { date: '2026-09-01', amount: 1000, count: 1 });
});
Deno.test('identical repeated sale is counted only once', () => {
  const result = dailySales(groupProducts([row(), row({ id: 'b' })]).values(), '2026-09');
  equal(result.days[0].amount, 1000); equal(result.days[0].count, 1);
});
Deno.test('different lot numbers are separate products', () => {
  equal(dailySales(groupProducts([row(), row({ id: 'b', lot_seq: 2 })]).values(), '2026-09').days[0].amount, 2000);
});
Deno.test('conflicting sales are flagged instead of selecting an arbitrary amount', () => {
  const result = dailySales(groupProducts([row(), row({ id: 'b', sold_price: 2000 })]).values(), '2026-09');
  equal(result.conflicts, [1]); equal(result.days[0].amount, 0);
});
Deno.test('different sale dates cannot duplicate a product across months', () => {
  const groups = groupProducts([row(), row({ id: 'b', sold_on: '2026-08-01' })]);
  equal(dailySales(groups.values(), '2026-09').conflicts, [1]); equal(dailySales(groups.values(), '2026-08').conflicts, [1]);
});
Deno.test('zero sale is valid while missing price is flagged', () => {
  equal(dailySales(groupProducts([row({ sold_price: 0, payout_amount: 0 })]).values(), '2026-09').days[0].count, 1);
  equal(dailySales(groupProducts([row({ sold_price: null })]).values(), '2026-09').conflicts, [1]);
});
Deno.test('empty days and leap year are represented', () => {
  equal(dailySales([], '2024-02').days.length, 29); equal(dailySales([], '2025-02').days.length, 28);
  equal(dailySales([], '2026-09').days.every(d => d.amount === 0), true);
});
Deno.test('unsold rows never become sales', () => {
  equal(dailySales(groupProducts([row({ sold_on: null })]).values(), '2026-09').days[0].count, 0);
});
Deno.test('month changes filter sale dates and group conflicts', () => {
  equal(dailySales(groupProducts([row()]).values(), '2026-08').days.every(d => d.amount === 0), true);
});
Deno.test('invalid month is rejected', () => {
  let rejected = false; try { dailySales([], '2026-13'); } catch { rejected = true; }
  equal(rejected, true);
});
