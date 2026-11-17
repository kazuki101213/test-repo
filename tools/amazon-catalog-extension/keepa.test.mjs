import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupKeepa } from './keepa.js';
import { asinFromUrl } from './amazon.js';

const asin = 'B07216NYPP';
const other = 'B012345678';
const time = 100_000_000;
function state(values) {
  return {
    values,
    get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
    set: async update => Object.assign(values, update),
  };
}
const failRequest = () => assert.fail('Unexpected Keepa request');

test('accepts Amazon Japan product URL variants only', () => {
  assert.equal(asinFromUrl('https://www.amazon.co.jp/a/dp/B07216NYPP?th=1'), asin);
  assert.equal(asinFromUrl('https://amazon.co.jp/gp/product/b07216nypp/ref=example'), asin);
  assert.equal(asinFromUrl('https://amazon.co.jp/gp/aw/d/B07216NYPP'), asin);
  assert.equal(asinFromUrl('https://www.amazon.co.jp.evil.invalid/dp/B07216NYPP'), null);
  assert.equal(asinFromUrl('https://amazon.co.jp/s?k=B07216NYPP'), null);
});

test('one lookup returns metrics and zero balance, then uses the cache without another request', async () => {
  const storage = state({ keepaKey: 'fixture' });
  const actual = await lookupKeepa(asin, storage, async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('domain'), '5');
    assert.equal(query.get('asin'), asin);
    assert.equal(query.get('stats'), '90');
    return Response.json({
      tokensLeft: 0, refillRate: 1, refillIn: 30_000,
      products: [{ asin, domainId: 5, model: 'MDR-EX155 B', monthlySold: 4000, stats: { salesRankDrops30: 41, salesRankDrops90: 145, avg30: [-1, 1325, 2052] } }],
    });
  }, () => time);
  assert.equal(actual.status, 'fetched');
  assert.equal(actual.entry.data.drops90, 145);
  assert.equal(actual.entry.data.new30, 1325);
  assert.equal(actual.quota.blockedUntil, time + 30_000);
  const cached = await lookupKeepa(asin, storage, failRequest, () => time + 500);
  assert.equal(cached.status, 'cached');
  assert.equal(cached.entry.data.monthlySold, 4000);
  assert.equal((await lookupKeepa(other, storage, failRequest, () => time + 500)).status, 'waiting');
});

test('HTTP 429 preserves stale results and suppresses retries until enough tokens can return', async () => {
  const entry = { savedAt: time - 7 * 60 * 60 * 1000, data: { model: 'previous' } };
  const storage = state({ keepaKey: 'fixture', keepaCache: { [asin]: entry } });
  const blocked = await lookupKeepa(asin, storage, async () =>
    Response.json({ tokensLeft: -1, refillIn: 30_000, refillRate: 1 }, { status: 429 }), () => time);
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.entry, entry);
  assert.equal(blocked.quota.blockedUntil, time + 90_000);
  assert.equal((await lookupKeepa(asin, storage, failRequest, () => time + 89_999)).status, 'waiting');
  const resumed = await lookupKeepa(asin, storage, async () =>
    Response.json({ tokensLeft: 2, products: [{ asin, domainId: 5, model: 'updated' }] }), () => time + 90_000);
  assert.equal(resumed.entry.data.model, 'updated');
});

test('a missing key and a network error leave registration independent of Keepa', async () => {
  assert.equal((await lookupKeepa(asin, state({}), failRequest, () => time)).status, 'missing-key');
  const unavailable = await lookupKeepa(asin, state({ keepaKey: 'fixture' }), async () => {
    throw new Error('Network failure');
  }, () => time);
  assert.equal(unavailable.status, 'unavailable');
});
