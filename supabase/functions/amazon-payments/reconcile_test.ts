import { candidates } from './reconcile.ts';
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
const item = { sku: 'sample-sku', asin: 'B000SAMPLE', quantity: 1, currency: 'JPY', amount: 8200 };
const transaction = { transaction_type: 'Shipment', status: 'RELEASED', order_id: '123-1234567-1234567', item_breakdowns: [item] };
const orderItem = { quantityOrdered: 1, product: { sellerSku: 'sample-sku', asin: 'B000SAMPLE', price: { unitPrice: { amount: '10000.00', currencyCode: 'JPY' } } } };
const order = { orderId: transaction.order_id, createdTime: '2026-08-01T16:30:00Z', salesChannel: { marketplaceId: 'A1VC38T7YXB528' }, orderItems: [orderItem] };
Deno.test('matches exact SKU with Japanese order day, unit price and item net payout', () => {
  const result = candidates(transaction, order);
  assert(result.sales.length === 1 && !result.results.length, 'Expected one unambiguous match');
  assert(result.sales[0].soldOn === '2026-08-02' && result.sales[0].price === 10000 && result.sales[0].payout === 8200, 'Wrong amounts/date');
});
for (const [name, t, o] of [
  ['refund', { ...transaction, transaction_type: 'Refund' }, order],
  ['deferred', { ...transaction, status: 'DEFERRED' }, order],
  ['missing SKU', { ...transaction, item_breakdowns: [{ ...item, sku: null }] }, order],
  ['multiple units', { ...transaction, item_breakdowns: [{ ...item, quantity: 2 }] }, order],
  ['duplicate payment SKU', { ...transaction, item_breakdowns: [item, item] }, order],
  ['duplicate order SKU', transaction, { ...order, orderItems: [orderItem, orderItem] }],
  ['different order', transaction, { ...order, orderId: 'different' }],
  ['different marketplace', transaction, { ...order, salesChannel: { marketplaceId: 'US' } }],
  ['missing date', transaction, { ...order, createdTime: null }],
  ['missing order price', transaction, { ...order, orderItems: [{ ...orderItem, product: { sellerSku: 'sample-sku' } }] }],
  ['different ASIN', { ...transaction, item_breakdowns: [{ ...item, asin: 'DIFFERENT' }] }, order],
  ['non yen', { ...transaction, item_breakdowns: [{ ...item, currency: 'USD' }] }, order],
  ['fractional net amount', { ...transaction, item_breakdowns: [{ ...item, amount: 8200.5 }] }, order],
  ['unknown net amount', { ...transaction, item_breakdowns: [{ ...item, amount: null }] }, order],
  ['negative net amount', { ...transaction, item_breakdowns: [{ ...item, amount: -1 }] }, order],
  ['legacy history lacks product info', { ...transaction, item_breakdowns: [] }, order],
] as const) {
  Deno.test(`requires review: ${name}`, () => {
    const result = candidates(t, o);
    assert(!result.sales.length && result.results.length > 0, 'Ambiguous data was auto matched');
  });
}
