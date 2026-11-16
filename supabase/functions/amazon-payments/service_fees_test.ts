import { handler } from './index.ts';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
const range = { postedAfter: '2026-08-01T00:00:00Z', postedBefore: '2026-08-31T00:00:00Z' };
const sample = { postedDate: '2026-08-05T01:00:00Z', transactionStatus: 'RELEASED', totalAmount: { currencyCode: 'JPY', currencyAmount: -1200 } };

Deno.test('weekly service fees use only released fee rows and return the page cursor', async () => {
  const originalFetch = globalThis.fetch;
  const env = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AMAZON_SELLER_ID',
    'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN'];
  const saved = env.map(name => Deno.env.get(name));
  const totals = { created: 2, matched: 0, linked: 0, zero: 0, review: 0 };
  const ids = ['fee-released', 'fee-deferred-released'];
  let upsert = 0, applied = 0;
  try {
    for (const name of env) Deno.env.set(name, name === 'SUPABASE_URL' ? 'https://test.supabase.co' : 'test-value');
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      }));
      if (url.includes('/auth/v1/user')) return json({ id: 'test-admin', aud: 'authenticated' });
      if (url.includes('/rpc/is_admin')) return json(true);
      if (url.includes('/auth/o2/token')) return json({ access_token: 'fake-token' });
      if (url.includes('/finances/')) {
        const transaction = { ...sample, transactionType: 'ServiceFee', description: 'Subscription' };
        return json({ payload: { nextToken: 'next-page', transactions: [
          { ...transaction, transactionId: ids[0] },
          { ...transaction, transactionId: ids[1], transactionStatus: 'DEFERRED_RELEASED' },
          { ...transaction, transactionId: 'pending', transactionStatus: 'DEFERRED' },
          { ...transaction, transactionId: 'order-payment', transactionType: 'Shipment' },
        ] } });
      }
      if (url.includes('/amazon_payment_transactions')) {
        upsert++;
        const rows = JSON.parse(String(init?.body));
        assert(JSON.stringify(rows.map((row: { transaction_id: string }) => row.transaction_id)) === JSON.stringify(ids),
          'Ineligible transaction was saved');
        return json(null);
      }
      if (url.includes('/rpc/apply_amazon_service_fee_expenses')) {
        applied++;
        const body = JSON.parse(String(init?.body));
        assert(JSON.stringify(body.p_transactions) === JSON.stringify(ids) && body.p_account_label === 'Amazon1',
          'Unexpected expense batch');
        return json(totals);
      }
      throw new Error('Unexpected fetch');
    }) as typeof fetch;
    const response = await handler(new Request('https://test/function', {
      method: 'POST', headers: { Authorization: 'Bearer test-admin' },
      body: JSON.stringify({ action: 'service-fees', accountId: 'amazon-1', ...range }),
    }));
    const result = await response.json();
    assert(response.status === 200 && upsert === 1 && applied === 1, 'Fee page was not applied exactly once');
    assert(result.expenses.created === 2 && result.nextToken === 'next-page', 'Invalid weekly response');
  } finally {
    globalThis.fetch = originalFetch;
    env.forEach((name, index) => saved[index] == null ? Deno.env.delete(name) : Deno.env.set(name, saved[index]!));
  }
});
