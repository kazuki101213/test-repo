import { handler } from './index.ts';
import { amazon2Seller, fbaEvidence, nextMonthDay, readOrders } from './sold-out-review.ts';

const marketplace = 'A1VC38T7YXB528';
const asin = 'B000000001';
const sku = '0021-test+A';
const fnsku = 'X000000001';
const stock = {
  sellerSku: sku, asin, fnSku: fnsku, totalQuantity: 0,
  inventoryDetails: { fulfillableQuantity: 0, inboundWorkingQuantity: 0, inboundShippedQuantity: 0, inboundReceivingQuantity: 0,
    reservedQuantity: { totalReservedQuantity: 0 }, unfulfillableQuantity: { totalUnfulfillableQuantity: 0 },
    researchingQuantity: { totalResearchingQuantity: 0 } },
};
const wrap = (value: unknown) => ({ payload: { inventorySummaries: [value] } });
const listing = {
  sku, summaries: [{ marketplaceId: marketplace, asin, status: [], conditionType: 'used_good',
    createdDate: '2024-01-01T00:00:00Z', lastUpdatedDate: '2024-01-05T00:00:00Z' }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 0 }, { fulfillmentChannelCode: 'AMAZON_JP' }],
};
const order = {
  orderId: '123-1234567-7654321', salesChannel: { marketplaceId: marketplace }, createdTime: '2024-01-05T20:00:00Z',
  fulfillment: { fulfillmentStatus: 'SHIPPED' }, orderItems: [{ product: { sellerSku: sku, asin },
    quantityOrdered: 1, fulfillment: { quantityFulfilled: 1 } }],
};
function expect(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}

Deno.test('one calendar month clamps at month end and respects leap years', () => {
  expect(nextMonthDay('2026-01-31') === '2026-02-28', 'non-leap year');
  expect(nextMonthDay('2024-01-31') === '2024-02-29', 'leap year');
  expect(nextMonthDay('2026-12-31') === '2027-01-31', 'year boundary');
});

Deno.test('zero stock, omitted stock, research stock, and FNSKU mismatch remain distinct', () => {
  expect(fbaEvidence(wrap(stock), sku, asin)?.missing === false, 'all quantities are known');
  expect(fbaEvidence(wrap({ ...stock, totalQuantity: null }), sku, asin)?.missing, 'null must remain unknown');
  expect(fbaEvidence(wrap({ ...stock, inventoryDetails: { researchingQuantity: { totalResearchingQuantity: 1 } } }), sku, asin)?.positive, 'researching stock blocks');
  expect(fbaEvidence(wrap({ ...stock, fnSku: '' }), sku, asin) === null, 'FNSKU required');
  expect(fbaEvidence({ ...wrap(stock), pagination: { nextToken: 'more' } }, sku, asin) === null, 'all pages required');
});

Deno.test('same ASIN, different SKU cannot be used as proof', () => {
  expect(readOrders([order], sku, asin).matches.size === 1, 'exact SKU matches');
  expect(readOrders([order], 'different SKU', asin).matches.size === 0, 'same ASIN alone does not match');
  expect(readOrders([order], sku, 'B000000000').incomplete, 'conflicting ASIN needs review');
});

const env = {
  SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'test-key', AMAZON_SELLER_ID: 'other-seller',
  AMAZON_2_SELLER_ID: amazon2Seller, AMAZON_2_LWA_CLIENT_ID: 'client', AMAZON_2_LWA_CLIENT_SECRET: 'secret',
  AMAZON_2_LWA_REFRESH_TOKEN: 'refresh',
};

for (const example of ['valid', 'restocked', 'change', 'open', 'wrong account', 'wrong seller', 'nonadmin', 'pagination', 'missing stock']) {
  Deno.test('Amazon2 review: ' + example, async () => {
    const previousFetch = globalThis.fetch;
    const names = Object.keys(env);
    const oldValues = names.map(name => Deno.env.get(name));
    for (const [name, value] of Object.entries(env)) Deno.env.set(name, value);
    if (example === 'wrong seller') Deno.env.set('AMAZON_2_SELLER_ID', 'wrong');
    let listingReads = 0, amazonCalls = 0, orderReads = 0;
    try {
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        const json = (value: unknown) => Promise.resolve(Response.json(value));
        if (url.pathname.endsWith('/auth/v1/user')) return json({ id: 'user' });
        if (url.pathname.endsWith('/rpc/is_admin')) return json(example !== 'nonadmin');
        if (url.pathname.endsWith('/item_sku_aliases')) return json([]);
        if (url.pathname.endsWith('/items') && url.hostname === 'test.supabase.co') return json([
          { id: 'item', sku, asin, sales_channel: 'FBA2', sold_on: '2024-01-05', updated_at: '2024-01-05T00:00:00Z' },
        ]);
        if (url.pathname.endsWith('/amazon_fba_customer_returns')) return json([{ returned_on: '2024-01-31' }]);
        amazonCalls++;
        if (url.pathname.endsWith('/auth/o2/token')) {
          expect(init?.method === 'POST', 'LWA authentication');
          return json({ access_token: 'test-token' });
        }
        expect(!init?.method || init.method === 'GET', 'Amazon listing or order writes are forbidden');
        if (url.pathname.includes('/listings/')) {
          expect(url.pathname.endsWith('/' + amazon2Seller + '/' + encodeURIComponent(sku)), 'exact seller and SKU');
          expect(url.searchParams.get('marketplaceIds') === marketplace, 'JP listing only');
          listingReads++;
          if (example === 'change' && listingReads === 2) {
            return json({ ...listing, summaries: [{ ...listing.summaries[0], lastUpdatedDate: '2024-02-01T00:00:00Z' }] });
          }
          return json(listing);
        }
        if (url.pathname.includes('/fba/inventory/')) {
          expect(url.searchParams.get('sellerSkus') === sku, 'no blanket FBA inventory access');
          if (example === 'restocked') return json(wrap({ ...stock, totalQuantity: 1 }));
          if (example === 'missing stock') return json(wrap({ ...stock, inventoryDetails: {} }));
          return json(wrap(stock));
        }
        if (url.pathname.includes('/orders/')) {
          orderReads++;
          if (example === 'pagination') return json({ orders: [], pagination: { nextToken: 'repeated' } });
          return json({ orders: [example === 'open' ? { ...order, fulfillment: { fulfillmentStatus: 'UNSHIPPED' } } : order] });
        }
        if (url.pathname.includes('/finances/')) {
          expect(url.searchParams.get('relatedIdentifierValue') === order.orderId, 'scope finances to exact order');
          return json({ payload: { transactions: [
            { transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2024-01-07T16:00:00Z' },
            { transactionType: 'Refund', transactionStatus: 'DEFERRED_RELEASED', postedDate: '2024-02-01T17:00:00Z' },
          ] } });
        }
        throw Error('Unexpected request: ' + url.pathname);
      };
      const response = await handler(new Request('https://test/functions', { method: 'POST',
        headers: { Authorization: 'Bearer test-session' },
        body: JSON.stringify({ action: 'review-sold-out', sku, accountId: example === 'wrong account' ? 'amazon-1' : 'amazon-2' }),
      }));
      if (['wrong account', 'wrong seller', 'nonadmin'].includes(example)) {
        expect(response.status === ({ 'wrong account': 400, 'wrong seller': 503, nonadmin: 403 })[example], 'access denied');
        expect(amazonCalls === 0, 'no calls to Amazon before authorization/account validation');
        return;
      }
      const result = await response.json();
      expect(response.ok && result.accountId === 'amazon-2' && result.sku === sku, JSON.stringify(result));
      if (example === 'restocked') {
        expect(result.state === 'excluded' && orderReads === 0, 'in-stock items must stop before order access');
      } else {
        expect(result.state === 'hold', 'API visibility gaps must keep the listing on hold');
        const reason = { change: '情報が変わった', open: '未発送', pagination: '最後まで取得', 'missing stock': '在庫内訳' }[example];
        if (reason) expect(result.reasons.some((message: string) => message.includes(reason)), JSON.stringify(result));
        if (example === 'valid') {
          expect(result.lastKnownEventOn === '2024-02-02' && result.reviewOn === '2024-03-02', 'refund date must supersede earlier sale and return dates in JST');
          expect(result.fnsku === fnsku && listingReads === 2, 'inventory identity and fresh listing checked again');
        }
      }
    } finally {
      globalThis.fetch = previousFetch;
      names.forEach((name, i) => oldValues[i] === undefined ? Deno.env.delete(name) : Deno.env.set(name, oldValues[i]!));
    }
  });
}
