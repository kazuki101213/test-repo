import { handler as inventory } from './amazon-fba-inventory/index.ts';
import { handler as payments } from './amazon-payments/index.ts';
import { amazonAccountId, amazonAccounts, amazonCredentials } from './_shared/amazonAccounts.ts';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
const fields = ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'LWA_REFRESH_TOKEN', 'SELLER_ID'];
const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', ...fields.flatMap(field => ['AMAZON_' + field, 'AMAZON_2_' + field])];
const range = { postedAfter: '2026-08-01T00:00:00Z', postedBefore: '2026-08-02T00:00:00Z' };
async function fixture(run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>, failFirst = false) {
  const saved = names.map(name => Deno.env.get(name)); const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    for (const name of names) Deno.env.set(name, name === 'SUPABASE_URL' ? 'https://test.supabase.co' : name.startsWith('AMAZON_2_') ? 'second-' + name : 'first-' + name);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/auth/v1/user')) return json({ id: 'admin', aud: 'authenticated' });
      if (url.includes('/rpc/is_admin') || url.includes('/rpc/verify_amazon_cron_token')) return json(true);
      if (url.includes('/staff?')) return json({ id: 'staff' });
      if (url.includes('/profiles?')) return json({ user_id: 'admin' });
      if (url.includes('/auth/o2/token')) {
        const form = new URLSearchParams(String(init?.body));
        const second = form.get('refresh_token') === 'second-AMAZON_2_LWA_REFRESH_TOKEN';
        const prefix = second ? 'second-AMAZON_2_' : 'first-AMAZON_';
        assert(form.get('client_id') === prefix + 'LWA_CLIENT_ID' && form.get('client_secret') === prefix + 'LWA_CLIENT_SECRET', 'Mixed credentials');
        return !second && failFirst ? json({ error: 'invalid_grant' }, 400) : json({ access_token: second ? 'token-second' : 'token-first' });
      }
      if (url.includes('/amazon_payment_transactions')) {
        if (init?.method === 'POST') return new Response(null, { status: 201 });
        return json([]);
      }
      if (url.includes('/sellers/v1/marketplaceParticipations')) return json({ payload: [{ marketplace: { id: 'A1VC38T7YXB528' } }] });
      if (url.includes('/orders/2026-01-01/orders/')) return json({ order: { orderId: '123-1234567-1234567', orderItems: [] } });
      if (url.includes('/orders/2026-01-01/orders?')) {
        const params = new URL(url).searchParams;
        assert(params.get('includedData') === 'PROCEEDS' && params.get('maxResultsPerPage') === '1', 'Probe requested excessive or personal data');
        return json({ orders: [{ orderId: '123-1234567-1234567' }] });
      }
      const second = new Headers(init?.headers).get('x-amz-access-token') === 'token-second';
      if (url.includes('/fba/inventory/')) return json({ payload: { inventorySummaries: [{ sellerSku: 'same-sku', asin: 'B0TEST', productName: second ? 'second' : 'first', totalQuantity: second ? 2 : 1 }] }, pagination: { nextToken: second ? 'page-second' : 'page-first' } });
      if (url.includes('/listings/')) {
        assert(url.includes(encodeURIComponent(second ? 'second-AMAZON_2_SELLER_ID' : 'first-AMAZON_SELLER_ID')), 'Wrong seller in listings');
        return json({ items: [{ sku: 'same-sku', summaries: [{ marketplaceId: 'A1VC38T7YXB528', status: ['BUYABLE'] }] }] });
      }
      if (url.includes('/finances/')) return json({ payload: { transactions: failFirst ? [] : [{ transactionId: 'same-id', postedDate: range.postedAfter, transactionType: 'Shipment', totalAmount: { currencyCode: 'JPY', currencyAmount: second ? 200 : 100 } }] } });
      throw new Error('Unexpected request');
    }) as typeof fetch;
    await run(calls);
  } finally {
    globalThis.fetch = original;
    names.forEach((name, index) => saved[index] === undefined ? Deno.env.delete(name) : Deno.env.set(name, saved[index]!));
  }
}
const request = (body: object, scheduled = false) => new Request('https://test/functions', { method: 'POST', headers: scheduled ? { 'x-amazon-cron-token': 'test-cron' } : { Authorization: 'Bearer test-session' }, body: JSON.stringify(body) });

Deno.test('separate credentials, strict account selection and no secondary fallback', () => fixture(async () => {
  assert(amazonAccountId(undefined) === 'amazon-1', 'Legacy default changed');
  for (const value of [null, '', 'AMAZON_', 2, '__proto__']) {
    let failed = false; try { amazonAccountId(value); } catch { failed = true; } assert(failed, 'Unknown account accepted');
  }
  assert(amazonAccounts().every(account => account.configured), 'Complete settings not detected');
  Deno.env.delete('AMAZON_2_LWA_REFRESH_TOKEN');
  let failed = false; try { amazonCredentials('amazon-2'); } catch { failed = true; } assert(failed, 'Secondary fell back to primary');
  Deno.env.set('AMAZON_2_LWA_REFRESH_TOKEN', 'second-AMAZON_2_LWA_REFRESH_TOKEN');
  Deno.env.set('AMAZON_2_SELLER_ID', Deno.env.get('AMAZON_SELLER_ID')!);
  failed = false; try { amazonCredentials('amazon-2'); } catch { failed = true; } assert(failed, 'Duplicate seller accepted');
}));

Deno.test('FBA uses selected token and seller with independent page tokens', () => fixture(async () => {
  for (const [accountId, name, count] of [['amazon-1', 'first', 1], ['amazon-2', 'second', 2]] as const) {
    const response = await inventory(request({ accountId })); const data = await response.json();
    assert(response.ok && data.accountId === accountId && data.rows[0].name === name && data.rows[0].total === count && data.nextToken === 'page-' + name, 'Account data mixed');
    assert(!JSON.stringify(data).includes('LWA_') && !JSON.stringify(data).includes('token-second'), 'Credentials leaked');
  }
}));

Deno.test('payment history keys and reads stay separate for identical transaction IDs', () => fixture(async calls => {
  for (const accountId of ['amazon-1', 'amazon-2']) {
    assert((await payments(request({ action: 'sync', accountId, ...range }))).ok, 'Sync failed');
    assert((await payments(request({ action: 'history', accountId, ...range }))).ok, 'History failed');
  }
  const writes = calls.filter(call => call.url.includes('/amazon_payment_transactions') && call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body))[0]);
  assert(writes.length === 2 && writes[0].transaction_id === writes[1].transaction_id && writes[0].account_key !== writes[1].account_key && writes[0].amount === 100 && writes[1].amount === 200, 'Payment histories overwrite');
  const reads = calls.filter(call => call.url.includes('/amazon_payment_transactions') && call.init?.method !== 'POST');
  writes.forEach((write, index) => assert(new URL(reads[index].url).searchParams.get('account_key') === 'eq.' + write.account_key, 'Cross-account history read'));
  const config = await (await payments(request({ action: 'accounts' }))).text();
  assert(!config.includes('first-AMAZON') && !config.includes('second-AMAZON'), 'Configuration exposed credentials');
}));

Deno.test('daily continues with Amazon2 when Amazon1 authentication fails', () => fixture(async calls => {
  const response = await payments(request({ action: 'daily' }, true)); const data = await response.json();
  assert(response.status === 207 && data.accounts.length === 2 && !data.accounts[0].ok && data.accounts[1].ok, 'One failure blocked the other account');
  assert(calls.filter(call => call.url.includes('/auth/o2/token')).length === 2, 'Accounts not processed once each');
}, true));

Deno.test('unconfigured Amazon2 and invalid IDs never call Amazon', () => fixture(async calls => {
  Deno.env.delete('AMAZON_2_LWA_REFRESH_TOKEN');
  for (const handler of [inventory, payments]) {
    const response = await handler(request({ action: 'sync', accountId: 'amazon-2', ...range }));
    assert(response.status === 503, 'Missing secondary credentials not rejected');
    assert((await handler(request({ action: 'sync', accountId: 'amazon-3', ...range }))).status === 400, 'Unknown ID accepted');
  }
  assert(calls.every(call => call.url.startsWith('https://test.supabase.co/')), 'Amazon called with incomplete settings');
}));

Deno.test('diagnosis checks seller-bound listings and non-PII order lookup without persisting data', () => fixture(async calls => {
  const response = await payments(request({ action: 'diagnose', accountId: 'amazon-2' }, true));
  const data = await response.json();
  assert(response.ok && data.listingsStatus === 200 && data.ordersStatus === 200 && data.orderLookupStatus === 200 && data.orderLookupShape, 'Application order flow not checked');
  const text = JSON.stringify(data);
  assert(!text.includes('123-1234567-1234567') && !text.includes('second-AMAZON') && !text.includes('token-second'), 'Order identity or credentials leaked');
  assert(calls.every(call => !call.url.includes('/amazon_payment_transactions') && !call.url.includes('/rpc/apply_amazon_')), 'Diagnosis persisted or reconciled data');
}));
