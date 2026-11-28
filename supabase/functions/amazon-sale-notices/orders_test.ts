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

Deno.test('records the unit price of a single-unit order', () => {
  const priced = { ...fixture, orderItems: [{ ...fixture.orderItems[0], quantityOrdered: 1,
    product: { ...fixture.orderItems[0].product, price: { unitPrice: { amount: '14980.0', currencyCode: 'JPY' } } } }] };
  assert.equal(confirmedOrderItems(priced)[0].amount, 14980);
  assert.equal(confirmedOrderItems(fixture)[0].amount, null);
  const multi = { ...priced, orderItems: [{ ...priced.orderItems[0], quantityOrdered: 2 }] };
  assert.equal(confirmedOrderItems(multi)[0].amount, null);
});
