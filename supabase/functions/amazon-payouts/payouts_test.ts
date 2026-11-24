import { fetchPayoutGroups, normalizePayoutGroup } from './payouts.ts';

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

Deno.test('振込グループを保存用の形にそろえる', () => {
  const group = normalizePayoutGroup({
    FinancialEventGroupId: 'g-1', ProcessingStatus: 'Closed', FundTransferStatus: 'Succeeded',
    OriginalTotal: { CurrencyCode: 'JPY', CurrencyAmount: 61013 },
    FundTransferDate: '2026-11-24T05:00:00Z', FinancialEventGroupStart: '2026-11-10T00:00:00Z', FinancialEventGroupEnd: '2026-11-24T04:00:00Z',
  }, 'acct', 'Amazon2', '2026-11-24T06:00:00.000Z');
  assertEquals(group, {
    account_key: 'acct', group_id: 'g-1', account_label: 'Amazon2', processing_status: 'Closed', fund_transfer_status: 'Succeeded',
    total: 61013, currency: 'JPY', fund_transfer_date: '2026-11-24T05:00:00.000Z', group_start: '2026-11-10T00:00:00.000Z',
    group_end: '2026-11-24T04:00:00.000Z', fetched_at: '2026-11-24T06:00:00.000Z',
  });
  assertEquals(normalizePayoutGroup({ ProcessingStatus: 'Open' }, 'acct', 'Amazon2', 'x'), null);
});

Deno.test('ページをたどって重複を除く', async () => {
  const urls: string[] = [];
  const pages = [
    { payload: { FinancialEventGroupList: [{ FinancialEventGroupId: 'a', ProcessingStatus: 'Closed' }], NextToken: 'n1' } },
    { payload: { FinancialEventGroupList: [{ FinancialEventGroupId: 'a', ProcessingStatus: 'Closed' }, { FinancialEventGroupId: 'b', ProcessingStatus: 'Open' }] } },
  ];
  const fetcher = ((url: string) => { urls.push(url); return Promise.resolve(new Response(JSON.stringify(pages[urls.length - 1]))); }) as unknown as typeof fetch;
  const groups = await fetchPayoutGroups({ token: 't', accountKey: 'k', accountLabel: 'Amazon1', fetcher, wait: () => Promise.resolve(), now: Date.parse('2026-11-24T00:00:00Z') });
  assertEquals(groups.map(group => group.group_id), ['a', 'b']);
  assertEquals(urls[0].includes('FinancialEventGroupStartedAfter=2026-09-25'), true);
  assertEquals(urls[1].includes('NextToken=n1'), true);
});

Deno.test('権限エラーは分かる文で止める', async () => {
  const fetcher = (() => Promise.resolve(new Response('{}', { status: 403 }))) as unknown as typeof fetch;
  let message = '';
  try { await fetchPayoutGroups({ token: 't', accountKey: 'k', accountLabel: 'Amazon1', fetcher }); } catch (error) { message = (error as Error).message; }
  assertEquals(message.includes('HTTP 403'), true);
});
