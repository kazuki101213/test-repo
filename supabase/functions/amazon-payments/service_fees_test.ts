import { handler } from './index.ts';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
Deno.test('unreflected payments open only for an administrator and show unsigned amounts', async () => {
  const originalFetch = globalThis.fetch;
  const env = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AMAZON_SELLER_ID'];
  const saved = env.map(name => Deno.env.get(name));
  let isAdmin = false, viewReads = 0;
  try {
    for (const name of env) Deno.env.set(name, name === 'SUPABASE_URL' ? 'https://test.supabase.co' : 'test-value');
    const seller = new TextEncoder().encode('test-value');
    const digest = await crypto.subtle.digest('SHA-256', seller);
    const accountKey = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const json = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      }));
      if (url.pathname === '/auth/v1/user') return json({ id: 'test-admin', aud: 'authenticated' });
      if (url.pathname === '/rest/v1/rpc/is_admin') return json(isAdmin);
      if (url.pathname === '/rest/v1/v_amazon_unreflected_payments') {
        viewReads++;
        assert(url.searchParams.get('offset') === '500' && url.searchParams.get('limit') === '500', 'Unexpected page');
        return json([{ account_key: accountKey, transaction_id: 'sample-1', transaction_day: '2026-11-16',
          transaction_type: 'ServiceFee', description: 'FBAPostInboundTransportation', amount: -832,
          currency: 'JPY', partially_reflected: false }]);
      }
      throw new Error('Unexpected request');
    }) as typeof fetch;
    const request = () => new Request('https://test/function', {
      method: 'POST', headers: { Authorization: 'Bearer test-admin' },
      body: JSON.stringify({ action: 'unreflected', offset: 500 }),
    });
    assert((await handler(request())).status === 403 && viewReads === 0, 'Non-admin read payment history');
    isAdmin = true;
    const response = await handler(request());
    const result = await response.json();
    assert(response.ok && viewReads === 1 && result.rows[0].account === 'Amazon1', 'Expected mapped seller account');
    assert(result.rows[0].amount === 832 && result.rows[0].description === 'FBA納品送料'
      && !JSON.stringify(result).includes(accountKey), 'Incorrect or excessive read model');
  } finally {
    globalThis.fetch = originalFetch;
    env.forEach((name, index) => saved[index] == null ? Deno.env.delete(name) : Deno.env.set(name, saved[index]!));
  }
});

const range = { postedAfter: '2026-08-01T00:00:00Z', postedBefore: '2026-08-31T00:00:00Z' };

Deno.test('review applies service fees and keeps settlements and deletions out of expenses', async () => {
  const originalFetch = globalThis.fetch;
  const env = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AMAZON_SELLER_ID'];
  const saved = env.map(name => Deno.env.get(name));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-value'));
  const accountKey = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const records = {
    fee: { transaction_type: 'ServiceFee', description: 'Subscription' },
    settlement: { transaction_type: 'DebtRecovery', description: 'DebtPayment' },
    unknown: { transaction_type: 'Unknown', description: 'Unknown' },
  };
  const resolutions: string[] = [];
  let admin = false;
  let expenseCalls = 0;
  try {
    for (const name of env) Deno.env.set(name, name === 'SUPABASE_URL' ? 'https://test.supabase.co' : 'test-value');
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/auth/v1/user') return json({ id: 'test-admin', aud: 'authenticated' });
      if (url.pathname === '/rest/v1/rpc/is_admin') return json(admin);
      if (url.pathname === '/rest/v1/v_amazon_unreflected_payments') {
        const id = url.searchParams.get('transaction_id')?.slice(3);
        const record = records[id as keyof typeof records];
        return json(record ? [{ ...record, transaction_id: id, account_key: accountKey, amount: -900, currency: 'JPY', status: 'RELEASED' }] : []);
      }
      if (url.pathname === '/rest/v1/rpc/apply_amazon_service_fee_expenses') {
        const args = JSON.parse(String(init?.body));
        assert(args.p_transactions[0] === 'fee', 'An unrelated transaction reached expense posting');
        expenseCalls++;
        return json({ created: 1 });
      }
      if (url.pathname === '/rest/v1/amazon_payment_review_resolutions' && init?.method === 'POST') {
        const row = JSON.parse(String(init.body));
        assert(row.resolved_by === 'test-admin' && row.account_key === accountKey, 'Wrong review actor or account');
        resolutions.push(row.transaction_id + ':' + row.resolution);
        return new Response(null, { status: 201 });
      }
      throw new Error('Unexpected request');
    }) as typeof fetch;
    const act = (id: string, decision: string, account = 'Amazon1') => handler(new Request('https://test/function', {
      method: 'POST', headers: { Authorization: 'Bearer test-admin' },
      body: JSON.stringify({ action: 'review-payment', paymentId: account + ':' + id, decision }),
    }));
    assert((await act('fee', 'reflect')).status === 403, 'Non-admin can review a transaction');
    admin = true;
    assert((await act('fee', 'reflect', 'Amazon2')).status === 409, 'Wrong account matched');
    assert((await act('unknown', 'reflect')).status === 409, 'An unknown adjustment was reflected');
    assert((await act('fee', 'reflect')).ok && expenseCalls === 1, 'Service fee was not booked');
    assert((await act('settlement', 'reflect')).ok && (await act('unknown', 'delete')).ok, 'Review actions failed');
    assert(resolutions.join(',') === 'settlement:settlement_confirmed,unknown:dismissed' && expenseCalls === 1, 'Wrong review resolutions');
  } finally {
    globalThis.fetch = originalFetch;
    env.forEach((name, index) => saved[index] == null ? Deno.env.delete(name) : Deno.env.set(name, saved[index]!));
  }
});

const sample = { postedDate: '2026-08-05T01:00:00Z', transactionStatus: 'RELEASED', totalAmount: { currencyCode: 'JPY', currencyAmount: -1200 } };

Deno.test('weekly sync saves released history and applies only service fees', async () => {
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
        assert(JSON.stringify(rows.map((row: { transaction_id: string }) => row.transaction_id))
          === JSON.stringify([...ids, 'order-payment']), 'Released history was not saved correctly');
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
