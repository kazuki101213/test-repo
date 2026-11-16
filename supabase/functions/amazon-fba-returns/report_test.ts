import { downloadReport, parseCustomerReturns, parseRemovalShipments } from './report.ts';

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

Deno.test('keeps all removal shipments for a SKU together, including packages without a tracking number', () => {
  const header = 'request-date\torder-id\tshipment-date\tsku\tfnsku\tshipped-quantity\tcarrier\ttracking-number';
  const first = '2026-11-15T20:00:00Z\tAb0987\t2026-11-17\t123a-AAII-20261114-1000\tX000123ABC\t1\tYAMATO\t008765432109';
  const second = first.replace('008765432109', '');
  const result = parseRemovalShipments('\uFEFF' + header + '\r\n' + first + '\r\n' + second);
  assert(result.length === 1 && result[0].source_sku === '123a-AAII-20261114-1000');
  const [shipped, untracked] = result[0].shipments;
  assert(shipped.removal_order_id === 'Ab0987' && shipped.requested_on === '2026-11-16');
  assert(shipped.tracking_no === '008765432109' && shipped.carrier === 'YAMATO');
  assert(untracked.tracking_no === '');
});
