import assert from 'node:assert/strict';
import { confirmedOrderItems, japanMarketplace } from './orders.ts';

const fixture = {
  orderId: '123-1234567-1234567', createdTime: '2026-11-17T04:00:00Z',
  salesChannel: { marketplaceId: japanMarketplace },
  fulfillment: { fulfilledBy: 'AMAZON', fulfillmentStatus: 'UNSHIPPED' },
  orderItems: [
    { orderItemId: 'item-1', product: { sellerSku: '2499-AAII-20261117-450', asin: 'B000000001', title: 'レコーダー' } },
    { orderItemId: 'item-2', fulfillment: { fulfillmentStatus: 'CANCELLED' }, product: { sellerSku: 'cancelled', asin: 'B000000002' } },
  ],
};

Deno.test('returns confirmed sales from FBA and merchant fulfillment', () => {
  for (const fulfilledBy of ['AMAZON', 'MERCHANT']) {
    const items = confirmedOrderItems({ ...fixture, fulfillment: { ...fixture.fulfillment, fulfilledBy } });
    assert.equal(items.length, 1);
    assert.equal(items[0].line_id, 'item-1');
    assert.equal(items[0].fulfillment, fulfilledBy);
  }
});

Deno.test('ignores pending, cancelled, and non-Japanese orders', () => {
  for (const state of ['PENDING', 'PENDING_AVAILABILITY', 'CANCELLED', 'UNFULFILLABLE'])
    assert.deepEqual(confirmedOrderItems({ ...fixture, fulfillment: { ...fixture.fulfillment, fulfillmentStatus: state } }), []);
  assert.deepEqual(confirmedOrderItems({ ...fixture, salesChannel: { marketplaceId: 'other' } }), []);
});
