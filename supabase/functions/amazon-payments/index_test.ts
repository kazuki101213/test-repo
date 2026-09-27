import { handler, normalizeTransaction, dateRange } from './index.ts';
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
const range = { postedAfter: '2026-08-01T00:00:00Z', postedBefore: '2026-08-31T00:00:00Z' };
const sample = { transactionId: 'transaction-test', postedDate: '2026-08-05T01:00:00Z', transactionType: 'Refund', transactionStatus: 'RELEASED', totalAmount: { currencyCode: 'JPY', currencyAmount: -1200 }, contexts: [{ contextType: 'PaymentsContext', paymentDate: '2026-08-06T00:00:00Z', paymentReference: 'do-not-store' }], breakdowns: [{ breakdownType: 'Fee', breakdownAmount: { currencyCode: 'JPY', currencyAmount: -200 } }], buyerEmail: 'do-not-store', sellingPartnerMetadata: { sellingPartnerId: 'do-not-store' } };
Deno.test('normalization preserves signed amounts and excludes unrelated data', () => {
  const result = normalizeTransaction(sample, 'hash', '2026-08-31T00:00:00Z');
  assert(result.amount === -1200 && result.breakdowns[0].amount === -200, 'Signed amounts changed');
  assert(result.payment_date === '2026-08-06T00:00:00.000Z', 'Payment date lost');
  assert(!JSON.stringify(result).includes('do-not-store'), 'Unneeded data persisted');
  assert(normalizeTransaction({ ...sample, totalAmount: {} }, 'hash', '').amount === null, 'Unknown amount became zero');
});
Deno.test('invalid date ranges are rejected', () => {
  for (const invalid of [{}, { ...range, postedBefore: 'invalid' }, { ...range, postedBefore: range.postedAfter }, { ...range, postedBefore: '2027-08-01' }, { ...range, postedAfter: '2025-08-01' }]) {
    let failed = false; try { dateRange(invalid, Date.parse('2026-09-01')); } catch { failed = true; }
    assert(failed, 'Invalid range accepted');
  }
});
for (const scenario of ['anonymous', 'invalid', 'nonadmin', 'missing', 'invalidRange', 'invalidPage', 'lwaError', 'amazon403', 'amazon429', 'malformed', 'badRecord', 'saveError', 'empty', 'emptyWithNext', 'success', 'history']) {
  Deno.test(scenario, async () => {
    const originalFetch = globalThis.fetch;
    const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'AMAZON_SELLER_ID', 'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_LWA_REFRESH_TOKEN'];
    const savedEnv = names.map(n => Deno.env.get(n));
    const calls: { url: string; method: string }[] = [];
    try {
      for (const n of names) Deno.env.set(n, n === 'SUPABASE_URL' ? 'https://test.supabase.co' : 'fake-secret');
      if (scenario === 'missing') Deno.env.delete('AMAZON_LWA_CLIENT_ID');
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input), method = init?.method ?? 'GET'; calls.push({ url, method });
        const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
        if (url.includes('/auth/v1/user')) return scenario === 'invalid' ? json({ message: 'invalid' }, 401) : json({ id: 'test-user', aud: 'authenticated' });
        if (url.includes('/rpc/is_admin')) return json(scenario !== 'nonadmin');
        if (url.includes('/auth/o2/token')) return scenario === 'lwaError' ? json({ error: 'invalid_grant', error_description: 'do-not-echo' }, 401) : json({ access_token: 'fake-amazon-token' });
        if (url.includes('/amazon_payment_transactions')) {
          if (scenario === 'history') { assert(method === 'GET', 'History writes'); return json([normalizeTransaction(sample, 'hash', range.postedBefore)]); }
          assert(method === 'POST', 'Expected one upsert');
          const records = JSON.parse(String(init?.body));
          assert(records.length === 1 && records[0].amount === -1200, 'Mapping/deduplication incorrect');
          assert(!JSON.stringify(records).includes('fake-secret') && !JSON.stringify(records).includes('do-not-store'), 'Secret/unneeded data stored');
          assert(url.includes('on_conflict=account_key%2Cmarketplace_id%2Ctransaction_id'), 'Idempotency key missing');
          return scenario === 'saveError' ? json({ message: 'do-not-echo' }, 500) : Promise.resolve(new Response(null, { status: 201 }));
        }
        assert(url.startsWith('https://sellingpartnerapi-fe.amazon.com/finances/2024-06-19/transactions?') && method === 'GET', 'Amazon write or incorrect path');
        const params = new URL(url).searchParams;
        assert(params.get('marketplaceId') === 'A1VC38T7YXB528', 'Wrong marketplace');
        assert(params.get('postedAfter') === new Date(range.postedAfter).toISOString(), 'Range changed');
        assert(params.get('nextToken') === 'test-next', 'Pagination lost');
        const h = new Headers(init?.headers);
        assert(h.get('x-amz-access-token') === 'fake-amazon-token' && /^\d{8}T\d{6}Z$/.test(h.get('x-amz-date') ?? ''), 'Missing Amazon headers');
        if (scenario.startsWith('amazon')) return json({ errors: [{ code: 'Unauthorized', message: 'do-not-echo' }] }, scenario === 'amazon429' ? 429 : 403);
        if (scenario === 'malformed') return json({ unexpected: 'do-not-echo' });
        if (scenario === 'badRecord') return json({ payload: { transactions: [{ ...sample, transactionId: null }] } });
        if (scenario.startsWith('empty')) return json({ payload: { transactions: [], ...(scenario === 'emptyWithNext' ? { nextToken: 'continue' } : {}) } });
        return json({ payload: { transactions: [sample, sample], nextToken: 'continue' } });
      }) as typeof fetch;
      const response = await handler(new Request('https://test/function', { method: 'POST', headers: scenario === 'anonymous' ? {} : { Authorization: 'Bearer fake-session' }, body: JSON.stringify({ action: scenario === 'history' ? 'history' : 'sync', ...range, nextToken: scenario === 'invalidPage' ? 42 : 'test-next', ...(scenario === 'invalidRange' ? { postedBefore: 'invalid' } : {}) }) }));
      const expected: Record<string, number> = { anonymous: 401, invalid: 401, nonadmin: 403, missing: 503, invalidRange: 400, invalidPage: 400, lwaError: 502, amazon403: 502, amazon429: 502, malformed: 502, badRecord: 502, saveError: 503 };
      const content = await response.text();
      assert(response.status === (expected[scenario] ?? 200), `${scenario}: ${response.status}: ${content}`);
      assert(!['fake-secret', 'fake-amazon-token', 'fake-session', 'do-not-echo'].some(s => content.includes(s)), 'Secrets/raw errors leaked');
      if (scenario === 'emptyWithNext') assert(JSON.parse(content).nextToken === 'continue', 'Empty page continuation lost');
      if (scenario.startsWith('empty')) assert(!calls.some(c => c.url.includes('/amazon_payment_transactions')), 'Empty page wrote data');
      if (scenario === 'history') assert(!calls.some(c => c.url.includes('amazon.com')), 'Saved history called Amazon');
      if (expected[scenario] && scenario !== 'saveError') assert(!calls.some(c => c.url.includes('/amazon_payment_transactions')), 'Failed request wrote data');
      if (['anonymous', 'invalid', 'nonadmin', 'invalidRange', 'invalidPage', 'missing'].includes(scenario)) assert(!calls.some(c => c.url.includes('amazon.com')), 'Amazon called before authorization/validation');
    } finally {
      globalThis.fetch = originalFetch;
      names.forEach((n, i) => savedEnv[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, savedEnv[i]!));
    }
  });
}
