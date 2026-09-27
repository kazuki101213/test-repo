import { productCount, readAllRows, inventoryWindow } from '../src/inventory.ts';
import { buildPurchaseUrl, parsePurchaseUrl } from '../src/purchaseUrl.ts';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({ actual, expected }));
}

Deno.test('scroll window reaches the final record with no 100-row limit', () => {
  const first = inventoryWindow(3160, 0, 600);
  equal(first.start, 0); equal(first.end < 100, true);
  const middle = inventoryWindow(3160, 1500 * 88 + 40, 600);
  equal(middle.start <= 1500 && middle.end > 1500, true);
  const last = inventoryWindow(3160, 3160 * 88 + 40 - 600, 600);
  equal(last.end, 3160); equal(last.bottom, 0);
  equal(last.top + (last.end - last.start) * 88 + last.bottom, 3160 * 88);
});

Deno.test('all 3160 rows are fetched beyond both 100 and 1000 row boundaries', async () => {
  const source = Array.from({ length: 3160 }, (_, n) => ({ id: String(n), lot_seq: n % 2324 }));
  const ranges: number[][] = [];
  const result = await readAllRows(async (from, to) => { ranges.push([from, to]); return source.slice(from, to + 1); });
  equal(result, source); equal(productCount(result), 2324); equal(ranges.length, 7);
});
Deno.test('empty result and exact batch multiple terminate without truncation', async () => {
  equal(await readAllRows(async () => []), []); equal(productCount([]), 0);
  const source = Array.from({ length: 1000 }, (_, n) => ({ id: String(n) }));
  equal((await readAllRows(async (from, to) => source.slice(from, to + 1))).length, 1000);
});
Deno.test('failed or cancelled later batch never returns a misleading partial total', async () => {
  const failure = new Error('cancelled');
  try {
    await readAllRows(async from => { if (from) throw failure; return Array.from({ length: 500 }, (_, n) => ({ id: String(n) })); });
    throw new Error('expected rejection');
  } catch (error) { if (error !== failure) throw error; }
});

for (const [name, id, url] of [
  ['メルカリ', 'm12345678901', 'https://jp.mercari.com/item/m12345678901'],
  ['ヤフオク', 'q1234567890', 'https://auctions.yahoo.co.jp/jp/auction/q1234567890'],
  ['ヤフフリ', 'z123456789', 'https://paypayfleamarket.yahoo.co.jp/item/z123456789'],
  ['PayPayフリマ', 'z123456789', 'https://paypayfleamarket.yahoo.co.jp/item/z123456789'],
  ['ラクマ', '0123456789abcdef0123456789abcdef', 'https://item.fril.jp/0123456789abcdef0123456789abcdef'],
] as const) {
  Deno.test(`${name} builds purchase URL from item ID`, () => { equal(buildPurchaseUrl(name, ` ${id} `)?.url, url); });
  Deno.test(`${name} accepts product URL and removes tracking query`, () => {
    equal(buildPurchaseUrl(name, url + '?utm_source=test')?.itemId, id);
    equal(parsePurchaseUrl(url)?.url, url);
  });
}
Deno.test('legacy Yahoo URL is normalized to the current host', () => {
  equal(parsePurchaseUrl('https://page.auctions.yahoo.co.jp/jp/auction/q1234567890')?.url,
    'https://auctions.yahoo.co.jp/jp/auction/q1234567890');
});
Deno.test('empty, mismatched marketplace, order IDs, unsafe and unknown URLs cannot generate links', () => {
  equal(buildPurchaseUrl('メルカリ', ''), null);
  equal(buildPurchaseUrl('ラクマ', '123456789'), null);
  equal(buildPurchaseUrl('店舗', 'm123'), null);
  equal(buildPurchaseUrl('ヤフオク', 'https://jp.mercari.com/item/m123'), null);
  equal(parsePurchaseUrl('javascript:alert(1)'), null);
  equal(parsePurchaseUrl('https://jp.mercari.com.evil.test/item/m123'), null);
  equal(parsePurchaseUrl('https://user:pass@jp.mercari.com/item/m123'), null);
  equal(buildPurchaseUrl('メルカリ', '../m123'), null);
});
