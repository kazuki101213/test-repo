const test = require('node:test');
const assert = require('node:assert/strict');
require('../../tools/fleamarket-extension/yahoo-untracked-sender.js');
const parser = globalThis.FleaYahooUntrackedSender;

test('captures only sender name and prefecture/city for ordinary mail', () => {
  const result = parser.parse(`配送方法\n定形外郵便\n出品者情報\n氏名\n山田 太郎\n住所\n東京都新宿区西新宿一丁目2-3\n落札者情報\n住所\n埼玉県川口市本町`);
  assert.deepEqual(result, { shippingMethod: '定形外郵便', senderName: '山田 太郎', senderPrefectureCity: '東京都新宿区' });
});

test('does not capture buyer address or infer seller information from another shipping method', () => {
  assert.deepEqual(parser.parse('配送方法\nおてがる配送\n出品者情報\n氏名\n山田\n住所\n東京都新宿区'),
    { shippingMethod: null, senderName: null, senderPrefectureCity: null });
  assert.deepEqual(parser.parse('配送方法\n定形外郵便\nお届け先\n住所\n埼玉県川口市'),
    { shippingMethod: '定形外郵便', senderName: null, senderPrefectureCity: null });
});

test('extracts city only and rejects an address without a municipality', () => {
  assert.equal(parser.prefectureCity('北海道札幌市中央区北一条西1丁目'), '北海道札幌市');
  assert.equal(parser.prefectureCity('千葉県'), '');
});
