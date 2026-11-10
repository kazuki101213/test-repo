import {handler} from './index.ts';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }

const project = 'https://test.supabase.co';
const worker = 'a4ee019c-ae57-46ce-a59e-4c9372406516';
const itemId = 'a67b319e-73b7-4816-9e10-89bf191fca46';
const sku = '1250c-AABB-20261101-400';
const asin = 'B0006NL5SM';
const image = 'https://m.media-amazon.com/images/P/B0006NL5SM.01.LZZZZZZZ.jpg';
const market = 'A1VC38T7YXB528';

for (const scenario of ['anonymous', 'other-worker', 'changed-channel', 'wrong-sku', 'unknown-fnsku', 'catalog-missing', 'with-photo', 'without-photo']) {
  Deno.test('FBA labels: ' + scenario, async () => {
    const originalFetch = globalThis.fetch;
    const values: Record<string, string> = {
      SUPABASE_URL: project, SUPABASE_ANON_KEY: 'test-key',
      AMAZON_2_LWA_CLIENT_ID: 'test-client', AMAZON_2_LWA_CLIENT_SECRET: 'test-secret',
      AMAZON_2_LWA_REFRESH_TOKEN: 'test-refresh', AMAZON_2_SELLER_ID: 'test-seller',
    };
    const previous = Object.keys(values).map(key => [key, Deno.env.get(key)] as const);
    const calls: string[] = [];
    try {
      for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url.href);
        const json = (value: unknown, status = 200) => Promise.resolve(Response.json(value, {status}));
        if (url.pathname === '/auth/v1/user') return json({id: 'fake-user'});
        if (url.pathname.endsWith('/rpc/current_staff_id')) return json(worker);
        if (url.pathname.endsWith('/rpc/is_admin')) return json(false);
        if (url.pathname.endsWith('/items')) return json([{
          sku, asin, title: 'beyerdynamic ヘッドホン', model_no: 'DT 770 PRO', condition: '非常に良い', sales_channel: 'FBA2', status: '商品登録前',
          is_accessory: true, deliverer_id: scenario === 'other-worker' ? 'different-worker' : worker,
        }]);
        if (url.pathname.endsWith('/staff')) return json([{is_active: true}]);
        if (url.pathname === '/auth/o2/token') {
          assert((init?.body as URLSearchParams).get('refresh_token') === 'test-refresh', 'Wrong Amazon account');
          return json({access_token: 'test-access'});
        }
        assert(url.hostname === 'sellingpartnerapi-fe.amazon.com' && (init?.method ?? 'GET') === 'GET', 'Unexpected Amazon write or host');
        assert(url.searchParams.get('marketplaceIds') === market, 'Wrong marketplace');
        if (url.pathname === '/fba/inventory/v1/summaries') {
          assert(url.searchParams.get('sellerSkus') === sku, 'Unmodified seller SKU required for Amazon');
          return json({payload: {inventorySummaries: [{
            sellerSku: scenario === 'wrong-sku' ? 'other-sku' : sku,
            asin, fnSku: scenario === 'unknown-fnsku' ? asin : 'X001234567', productName: 'DT 770 PRO',
          }]}});
        }
        if (url.pathname === '/catalog/2022-04-01/items/' + asin) {
          if (scenario === 'catalog-missing') return json({error: 'unavailable'}, 403);
          return json({asin, images: [{marketplaceId: market, images: [{variant: 'PT01', link: image}, {variant: 'MAIN', link: image}]}]});
        }
        throw new Error('Unexpected endpoint: ' + url.pathname);
      }) as typeof fetch;
      const response = await handler(new Request(project, {method: 'POST',
        headers: scenario === 'anonymous' ? {} : {Authorization: 'Bearer test-session'},
        body: JSON.stringify({itemId, expectedSku: sku, expectedChannel: scenario === 'changed-channel' ? 'FBA1' : 'FBA2', includePhoto: scenario !== 'without-photo'}),
      }));
      const expected: Record<string, number> = {anonymous: 401, 'other-worker': 403, 'changed-channel': 409, 'wrong-sku': 409, 'unknown-fnsku': 409};
      assert(response.status === (expected[scenario] ?? 200), 'Incorrect status: ' + response.status);
      const body = await response.json();
      if (response.ok) {
        assert(body.fnsku === 'X001234567' && body.condition === '非常に良い', 'Incorrect label');
        assert(body.modelNo === 'DT 770 PRO', 'Inventory model number missing');
        assert(body.image === (scenario === 'with-photo' ? image : null), 'Incorrect image');
      }
      if (['anonymous','other-worker','changed-channel'].includes(scenario)) assert(!calls.some(url => url.includes('amazon.com')), 'Amazon contacted before access checks');
      if (scenario === 'without-photo') assert(!calls.some(url => url.includes('/catalog/')), 'Unrequested photo lookup');
      assert(!JSON.stringify(body).includes('test-access'), 'Amazon credential leaked');
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of previous) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  });
}
