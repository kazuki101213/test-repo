import { assertEquals } from 'https://cdn.jsdelivr.net/gh/denoland/deno_std@0.224.0/assert/mod.ts';
import { payoutCorrection, targetCostFor } from './index.ts';

Deno.test('rule target follows the profit rule brackets', () => {
  assertEquals([targetCostFor(10000, null), targetCostFor(42775, null), targetCostFor(60000, null)], [7700, 34220, 49800]);
  assertEquals(targetCostFor(20000, 15), 17000);
});

Deno.test('same payout needs no change', () => {
  assertEquals(payoutCorrection({ payout_estimate: 40027, target_cost: 32022, target_profit_rate: null }, 40027), null);
});

Deno.test('a rule target is recalculated from the new payout (DBR-UT209 case)', () => {
  assertEquals(payoutCorrection({ payout_estimate: 42775, target_cost: 34220, target_profit_rate: null }, 40027),
    { payout_estimate: 40027, target_cost: 32022, manual_target_kept: false });
});

Deno.test('a one-yen rounding difference still counts as the rule', () => {
  assertEquals(payoutCorrection({ payout_estimate: 39111, target_cost: 31288, target_profit_rate: null }, 41859)?.target_cost, 33487);
});

Deno.test('an entered profit rate is used', () => {
  assertEquals(payoutCorrection({ payout_estimate: 20000, target_cost: 17000, target_profit_rate: 15 }, 21000)?.target_cost, 17850);
});

Deno.test('a hand-entered target is kept', () => {
  assertEquals(payoutCorrection({ payout_estimate: 30000, target_cost: 20000, target_profit_rate: null }, 31000),
    { payout_estimate: 31000, target_cost: 20000, manual_target_kept: true });
});
