import { handler, matchOpenOrder } from './index.ts';

const project = 'https://test.supabase.co';
const itemId = 'a67b319e-73b7-4816-9e10-89bf191fca46';
const worker = 'a4ee019c-ae57-46ce-a59e-4c9372406516';
const asin = 'B07216NYPP';
const sku = '2490-AAAA-20261110-50';
const alias = '123456789';
const bought = Date.parse('2025-11-10T00:00:00+09:00');

const amazonOrder = {
  orderId: '000-1234567-1234567', createdTime: '2025-11-12T01:00:00Z',
  salesChannel: { marketplaceId: 'A1VC38T7YXB528' },
  fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'UNSHIPPED',
    shipByWindow: { latestDateTime: '2025-11-13T08:00:00Z' } },
  orderItems: [{ orderItemId: 'test-line', product: { asin, sellerSku: alias }, quantityOrdered: 1 }],
  recipient: { deliveryAddress: { addressLine1: 'PRIVATE-ADDRESS' } },
  buyer: { name: 'PRIVATE-BUYER' },
};

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

Deno.test('matches only the exact marketplace, fulfillment, ASIN and historical SKU, including open items on partially shipped orders', () => {
  const match = (order: unknown) => matchOpenOrder(order, new Set([sku, alias]), asin, bought);
  const fulfillment = { ...amazonOrder.fulfillment, fulfillmentStatus: 'PARTIALLY_SHIPPED' };
  const [line] = amazonOrder.orderItems;
  assert(match(amazonOrder)[0]?.amazonSku === alias, 'Historical SKU did not match');
  assert(!match({ ...amazonOrder, salesChannel: { marketplaceId: 'other' } }).length, 'Wrong country matched');
  assert(!match({ ...amazonOrder, fulfillment: { ...fulfillment, fulfilledBy: 'AMAZON' } }).length, 'FBA matched');
  assert(!match({ ...amazonOrder, fulfillment: { ...fulfillment, fulfillmentStatus: 'CANCELLED' } }).length, 'Cancelled order matched');
  assert(!match({ ...amazonOrder, orderItems: [{ ...line, product: { ...line.product, asin: 'B00NOTMINE' } }] }).length, 'Wrong ASIN matched');
  assert(!match({ ...amazonOrder, fulfillment }).length, 'Partial order matched without item-level quantity');
  assert(match({ ...amazonOrder, fulfillment, orderItems: [{ ...line, fulfillment: { quantityUnfulfilled: 1 } }] }).length === 1, 'Unshipped item missed');
});

for (const scenario of ['amazon-1', 'amazon-2', 'anonymous', 'other-worker', 'shipped', 'two-matches', 'no-order']) {
  Deno.test('self-shipping lookup ' + scenario, async () => {
    const env: Record<string, string> = {
      SUPABASE_URL: project, SUPABASE_ANON_KEY: 'anon-fixture',
      AMAZON_SELLER_ID: 'A1WI3OGPE43N2T', AMAZON_LWA_CLIENT_ID: 'one', AMAZON_LWA_CLIENT_SECRET: 'one', AMAZON_LWA_REFRESH_TOKEN: 'one',
      AMAZON_2_SELLER_ID: 'A3E7BXJWH9TP11', AMAZON_2_LWA_CLIENT_ID: 'two', AMAZON_2_LWA_CLIENT_SECRET: 'two', AMAZON_2_LWA_REFRESH_TOKEN: 'two',
    };
    const previous = Object.entries(env).map(([key, value]) => {
      const old = Deno.env.get(key);
      Deno.env.set(key, value);
      return [key, old] as const;
    });
    const original = globalThis.fetch;
    let searched = 0;
    try {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const json = (data: unknown) => Promise.resolve(Response.json(data));
        if (url.pathname === '/auth/v1/user') return json({ id: worker });
        if (url.pathname.endsWith('/current_staff_id')) return json(worker);
        if (url.pathname.endsWith('/staff')) return json([{ role: 'deliverer', is_active: true }]);
        if (url.pathname.endsWith('/items')) return json([{
          sku, asin, purchased_at: '2025-11-10', status: '取引中', is_accessory: false,
          sales_channel: scenario === 'amazon-1' ? '自己発送1' : '自己発送2',
          shipped_on: scenario === 'shipped' ? '2025-11-13' : null,
          deliverer_id: scenario === 'other-worker' ? itemId : worker,
        }]);
        if (url.pathname.endsWith('/item_sku_aliases')) {
          assert(url.searchParams.get('item_id') === 'eq.' + itemId, 'Unscoped alias query');
          return json([{ sku: alias }]);
        }
        if (url.host === 'api.amazon.com') {
          assert((init?.body as URLSearchParams).get('refresh_token') === (scenario === 'amazon-1' ? 'one' : 'two'), 'Wrong seller credential');
          return json({ access_token: 'test-token' });
        }
        assert(url.host === 'sellingpartnerapi-fe.amazon.com' && (init?.method ?? 'GET') === 'GET', 'Unexpected request or Amazon write');
        searched++;
        assert(url.searchParams.get('includedData') === 'FULFILLMENT', 'Personal data was requested');
        if (scenario === 'no-order') return json({ orders: [] });
        if (scenario === 'two-matches') {
          return url.searchParams.has('paginationToken')
            ? json({ orders: [{ ...amazonOrder, orderId: '000-2345678-2345678' }] })
            : json({ orders: [amazonOrder], pagination: { nextToken: 'another-page' } });
        }
        return json({ orders: [amazonOrder] });
      }) as typeof fetch;
      const result = await handler(new Request(project, {
        method: 'POST', body: JSON.stringify({ itemId, account: 'client-supplied-account' }),
        headers: scenario === 'anonymous' ? {} : { Authorization: 'Bearer session' },
      }));
      const expected: Record<string, number> = { anonymous: 401, 'other-worker': 403, shipped: 409, 'two-matches': 409, 'no-order': 404 };
      assert(result.status === (expected[scenario] ?? 200), 'Wrong response: ' + result.status + ' ' + await result.clone().text());
      assert(searched === (scenario === 'two-matches' ? 2 : ['anonymous', 'other-worker', 'shipped'].includes(scenario) ? 0 : 1), 'Unexpected lookup count');
      const body = await result.text();
      assert(!body.includes('PRIVATE-') && !body.includes('test-token'), 'Information leaked');
      if (result.ok) {
        const order = JSON.parse(body);
        assert(order.account === scenario && order.orderId === amazonOrder.orderId && order.amazonSku === alias && order.shipBy, 'Wrong order');
      }
    } finally {
      globalThis.fetch = original;
      for (const [key, value] of previous) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  });
}
