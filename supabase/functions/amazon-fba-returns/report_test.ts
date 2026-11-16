import { downloadReport, parseCustomerReturns } from './report.ts';

const header = 'return-date\torder-id\tsku\tquantity\treason\tdetailed-disposition\tstatus\tlicense-plate-number\tcustomer-comments';
const first = '2026-11-15T20:00:00Z\t111-1234567-1234567\t1234-AAII-20261101-1000\t1\tDEFECTIVE\tCUSTOMER_DAMAGED\tUnit returned to inventory\tLPN1';
const assert = (condition: unknown) => { if (!condition) throw Error('Assertion failed'); };

Deno.test('reads the Amazon TSV, Tokyo date, quoted comments and identical duplicates', () => {
  const row = first + '\t"one ""quoted"" word\nand a tab\tinside"';
  const result = parseCustomerReturns('\uFEFF' + header + '\r\n' + row + '\r\n' + row, '2026-11-16');
  assert(result.length === 1);
  assert(result[0].returned_on === '2026-11-16' && result[0].quantity === 1 && result[0].reason === 'DEFECTIVE');
  assert(!result[0].conflict && !('customer_comments' in result[0]));
  assert(parseCustomerReturns(header + '\n' + row, '2026-11-17').length === 0);
});

Deno.test('marks conflicting lines for the same order and SKU and rejects a different report', () => {
  const result = parseCustomerReturns(header + '\n' + first + '\n' + first.replace('LPN1', 'LPN2'), '2026-11-15');
  assert(result.length === 1 && result[0].conflict);
  let bad = false;
  try { parseCustomerReturns('order-id\tsku\n123\tabc', '2026-11-15'); } catch { bad = true; }
  assert(bad);
});

Deno.test('downloads and decodes a gzip report without sending the Amazon token', async () => {
  const encoded = new Blob([header + '\n' + first]).stream().pipeThrough(new CompressionStream('gzip'));
  const result = await downloadReport('https://example.cloudfront.net/report', 'GZIP', (_url, options) => {
    assert(!options?.headers);
    return Promise.resolve(new Response(encoded));
  });
  assert(parseCustomerReturns(result, '2026-11-15').length === 1);
});
