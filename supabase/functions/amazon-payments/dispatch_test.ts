import { orderDispatchEvidence, syncDispatchDates } from './dispatch.ts';

const now = Date.parse('2026-11-12T01:00:00Z');
const shippedAt = '2026-11-11T16:42:00.000Z';
const sku = 'sample-merc-01';
const asin = 'B000000001';
function order() {
  return {
    orderId: '123-1234567-1234567', createdTime: '2026-11-11T09:00:00Z',
    salesChannel: { marketplaceId: 'A1VC38T7YXB528' },
    fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'SHIPPED' },
    orderItems: [{ orderItemId: 'line-01', quantityOrdered: 1, product: { sellerSku: sku, asin } }],
    packages: [{ shipTime: shippedAt, packageItems: [{ orderItemId: 'line-01', quantity: 1 }] }],
  };
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`Unexpected result: ${JSON.stringify(actual)}`);
}

Deno.test('Uses actual handoff time and the Japanese calendar date', () => {
  equal(orderDispatchEvidence(order(), now), [{
    sku, asin, orderId: '123-1234567-1234567', orderedOn: '2026-11-11',
    shippedAt, shippedOn: '2026-11-12',
  }]);
});
Deno.test('Planned, Amazon-fulfilled, unrelated, duplicate and cancelled packages do not set a date', () => {
  const base = order();
  for (const bad of [
    { ...base, packages: [{ ...base.packages[0], shipTime: undefined, createdTime: shippedAt }] },
    { ...base, fulfillment: { fulfilledBy: 'AMAZON' } },
    { ...base, fulfillment: { ...base.fulfillment, fulfillmentStatus: 'CANCELLED' } },
    { ...base, packages: [{ ...base.packages[0], packageItems: [{ orderItemId: 'different', quantity: 1 }] }] },
    { ...base, packages: [base.packages[0], base.packages[0]] },
    { ...base, packages: [{ ...base.packages[0], shipTime: '2026-11-11T08:00:00Z' }] },
  ]) equal(orderDispatchEvidence(bad, now), []);
});

function database(allowWrite = true, aliases: { item_id: string; sku: string }[] = [], aliasFailure = false) {
  const writes: Record<string, unknown>[] = [];
  const rows = [{
    id: 'inventory-01', sku, asin, sales_channel: '自己発送2', status: '取引中',
    purchased_at: '2026-11-01', sold_on: null, updated_at: '2026-11-11T12:30:00Z',
  }];
  const db = { rpc: async (name: string, values: Record<string, unknown>) => {
    equal(name, 'apply_amazon_self_dispatch');
    writes.push(values);
    return { data: allowWrite, error: null };
  }, from(table: string) {
    const filters: Record<string, unknown> = {};
    const query = {
      select: () => query,
      in: (name: string, values: string[]) => { filters[name] = values; return query; },
      is: (name: string, value: unknown) => { filters[name] = value; return query; },
      not: () => query, order: () => query,
      range: async () => {
        if (table === 'item_sku_aliases') {
          equal(filters.item_id, ['inventory-01']);
          return aliasFailure ? { data: null, error: new Error('read failed') } : { data: aliases, error: null };
        }
        equal(table, 'items');
        equal(filters.sales_channel, ['自己発送2']);
        return { data: rows, error: null };
      },
    };
    return query;
  } };
  return { db: db as unknown as Parameters<typeof syncDispatchDates>[0]['db'], writes };
}

Deno.test('Isolates the Amazon account, reads packages only, and protects a concurrently saved date', async () => {
  for (const allowWrite of [true, false]) {
    const { db, writes } = database(allowWrite);
    const result = await syncDispatchDates({ db, accountId: 'amazon-2', token: 'test-token', now,
      fetcher: async (input, options) => {
        const url = new URL(String(input));
        equal(url.searchParams.get('includedData'), 'FULFILLMENT,PACKAGES');
        equal(url.searchParams.get('fulfilledBy'), 'MERCHANT');
        equal(new Headers(options?.headers).get('x-amz-access-token'), 'test-token');
        return Response.json({ orders: [order()] });
      },
    });
    equal(result, { checked: 1, updated: allowWrite ? [{ sku, shippedAt, shippedOn: '2026-11-12' }] : [] });
    equal(writes, [{ p_item: 'inventory-01', p_account: 'amazon-2', p_sku: sku, p_asin: asin,
      p_status: '取引中', p_updated_at: '2026-11-11T12:30:00Z', p_shipped_on: '2026-11-12',
    }]);
  }
});
Deno.test('Checks all pages and skips an SKU linked to two orders', async () => {
  const { db, writes } = database();
  const result = await syncDispatchDates({ db, accountId: 'amazon-2', token: 'test-token', now,
    fetcher: async input => new URL(String(input)).searchParams.has('paginationToken')
      ? Response.json({ orders: [{ ...order(), orderId: '124-1234567-1234567' }] })
      : Response.json({ orders: [order()], pagination: { nextToken: 'page-2' } }),
  });
  equal(result, { checked: 1, updated: [] });
  equal(writes, []);
});

Deno.test('2490: matches the original Amazon SKU and writes using the current inventory SKU', async () => {
  const alias = '123456789';
  const { db, writes } = database(true, [{ item_id: 'inventory-01', sku: alias }]);
  const sample = order();
  sample.orderItems[0].product.sellerSku = alias;
  const result = await syncDispatchDates({ db, accountId: 'amazon-2', token: 'test-token', now,
    fetcher: async () => Response.json({ orders: [sample] }),
  });
  equal(result, { checked: 1, updated: [{ sku: alias, shippedAt, shippedOn: '2026-11-12' }] });
  equal(writes.length, 1);
  equal(writes[0].p_sku, sku);
  equal(writes[0].p_item, 'inventory-01');
});
Deno.test('Different orders across current and original SKU cannot select a dispatch date', async () => {
  const alias = '123456789';
  const { db, writes } = database(true, [{ item_id: 'inventory-01', sku: alias }]);
  const other = order();
  other.orderId = '124-1234567-1234567';
  other.orderItems[0].product.sellerSku = alias;
  const result = await syncDispatchDates({ db, accountId: 'amazon-2', token: 'test-token', now,
    fetcher: async () => Response.json({ orders: [order(), other] }),
  });
  equal(result, { checked: 1, updated: [] });
  equal(writes, []);
});
Deno.test('Alias lookup failure stops the sync without recording a dispatch', async () => {
  const { db, writes } = database(true, [], true);
  let calls = 0;
  try {
    await syncDispatchDates({ db, accountId: 'amazon-2', token: 'test-token', now,
      fetcher: async () => { calls++; return Response.json({ orders: [order()] }); },
    });
    throw Error('Expected alias lookup failure');
  } catch (error) {
    equal((error as Error).message, 'Amazonの旧SKUとの紐づけを確認できません。');
  }
  equal(calls, 0);
  equal(writes, []);
});
