import assert from 'node:assert/strict';
import { parseSellerInventory } from './report.ts';

const headers = 'seller-sku\tasin1\tfulfillment-channel\tstatus\tquantity';

Deno.test('uses the reported status for both fulfillment types, independently of quantity', () => {
  const result = parseSellerInventory([
    '\uFEFF' + headers,
    'fba\tB000000001\tAMAZON_JP\tActive\t0',
    'self\tB000000002\tDEFAULT\tInactive\t1',
    'pending\tB000000003\tDEFAULT\tIncomplete\t1',
  ].join('\r\n'));
  assert.deepEqual(result, {
    rows: [
      { sku: 'fba', asin: 'B000000001', fulfillment: 'fba', state: 'active' },
      { sku: 'self', asin: 'B000000002', fulfillment: 'self', state: 'inactive' },
    ],
    unknown: 1,
  });
});

Deno.test('discards conflicting rows while accepting identical copies', () => {
  const result = parseSellerInventory([
    headers,
    'a\tB000000001\tAMAZON_JP\tActive\t0',
    'a\tB000000001\tAMAZON_JP\tInactive\t0',
    'b\tB000000001\tDEFAULT\tActive\t1',
    'b\tB000000001\tDEFAULT\tActive\t1',
  ].join('\n'));
  assert.deepEqual(result, { rows: [{ sku: 'b', asin: 'B000000001', fulfillment: 'self', state: 'active' }], unknown: 1 });
  assert.throws(() => parseSellerInventory('seller-sku\tasin1\tfulfillment-channel'), /全出品レポート/);
});

Deno.test('reads ASINs from the product ID layout returned for Japan', () => {
  const result = parseSellerInventory([
    'item-name\tseller-sku\tproduct-id-type\tproduct-id\tfulfillment-channel\tstatus',
    'Blu-ray\tplayer\t1\tB000000001\tAMAZON_JP\tActive',
    'Monitor\tmonitor\t3\t0123456789\tDEFAULT\tActive',
  ].join('\n'));
  assert.deepEqual(result, { rows: [{ sku: 'player', asin: 'B000000001', fulfillment: 'fba', state: 'active' }], unknown: 1 });
});
