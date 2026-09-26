import { handler } from './index.ts';

const secretNames = ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN', 'AMAZON_SELLER_ID'];
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }

for (const scenario of ['anonymous', 'invalid', 'nonadmin', 'missing', 'success', 'amazon403']) {
  Deno.test(scenario, async () => {
    const originalFetch = globalThis.fetch;
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', ...secretNames];
    const originalEnv = names.map(name => Deno.env.get(name));
    const calls: string[] = [];
    try {
      Deno.env.set('SUPABASE_URL', 'https://test.supabase.co');
      Deno.env.set('SUPABASE_ANON_KEY', 'test-key');
      for (const name of secretNames) {
        if (scenario === 'missing') Deno.env.delete(name); else Deno.env.set(name, 'test-only');
      }
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input); calls.push(url);
        const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
        if (url.includes('/auth/v1/user')) return scenario === 'invalid' ? json({ message: 'invalid' }, 401) : json({ id: 'test-user', aud: 'authenticated' });
        if (url.includes('/rpc/is_admin')) return json(scenario !== 'nonadmin');
        if (url.includes('/auth/o2/token')) return json({ access_token: 'fake-token' });
        assert(!init?.method || init.method === 'GET', 'Amazon business API must be read-only');
        assert(url.startsWith('https://sellingpartnerapi-fe.amazon.com/'), 'Unexpected endpoint');
        assert(new URL(url).searchParams.get('marketplaceIds') === 'A1VC38T7YXB528', 'Wrong marketplace');
        if (scenario === 'amazon403') return json({ secret: 'must-not-echo' }, 403);
        if (url.includes('/fba/inventory')) return json({ payload: { inventorySummaries: [{ sellerSku: 'test-sku', asin: 'test-asin', productName: 'test', totalQuantity: 3, inventoryDetails: { fulfillableQuantity: 2 } }] }, pagination: { nextToken: 'next-page' } });
        if (url.includes('/listings/')) return json({ items: [{ sku: 'test-sku', summaries: [{ marketplaceId: 'A1VC38T7YXB528', status: ['BUYABLE'] }] }] });
        throw new Error('Unexpected network call');
      }) as typeof fetch;
      const response = await handler(new Request('https://test/functions', { method: 'POST', headers: scenario === 'anonymous' ? {} : { Authorization: 'Bearer fake-session' }, body: '{}' }));
      const expected = { anonymous: 401, invalid: 401, nonadmin: 403, missing: 503, success: 200, amazon403: 502 }[scenario];
      assert(response.status === expected, `Expected ${expected}, got ${response.status}`);
      const text = await response.text();
      assert(!text.includes('must-not-echo') && !text.includes('fake-token'), 'Credential/upstream payload leaked');
      if (['anonymous', 'invalid', 'nonadmin', 'missing'].includes(scenario)) assert(calls.every(url => !url.includes('amazon.com')), 'Amazon called before authorization/config validation');
      if (scenario === 'success') {
        const body = JSON.parse(text);
        assert(body.rows[0].fulfillable === 2 && body.rows[0].status[0] === 'BUYABLE', 'Incorrect mapping');
        assert(body.nextToken === 'next-page', 'Pagination lost');
      }
    } finally {
      globalThis.fetch = originalFetch;
      names.forEach((name, index) => originalEnv[index] === undefined ? Deno.env.delete(name) : Deno.env.set(name, originalEnv[index]!));
    }
  });
}
