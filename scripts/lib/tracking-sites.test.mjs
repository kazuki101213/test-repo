/**
 * 追跡番号の抽出とサイト定義のテスト
 *   node --test scripts/lib/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SITES, extractTracking, extractStatus } from './tracking-sites.mjs';

test('ラベル付きの追跡番号を拾う', () => {
  const cases = [
    ['配送方法\nヤマト運輸\nお問い合わせ番号 : 4213-5566-7788\n配達完了', '421355667788', 'ヤマト運輸'],
    ['ゆうパック\n追跡番号：12345678901\n配達中', '12345678901', '日本郵便'],
    ['伝票番号： 9876 5432 1098\nクロネコヤマト', '987654321098', 'ヤマト運輸'],
    ['お問合せ番号:123456789012', '123456789012', 'ヤマト運輸'],
    ['送り状番号 : 11112222333', '11112222333', '日本郵便'],
  ];
  for (const [text, number, carrier] of cases) {
    const got = extractTracking(text);
    assert.equal(got.number, number, text);
    assert.equal(got.carrier, carrier, text);
    assert.equal(got.confidence, 'high', text);
  }
});

test('ラベルが無い場合は確度 low で拾う', () => {
  const got = extractTracking('ネコポスで発送しました 400123456789');
  assert.equal(got.number, '400123456789');
  assert.equal(got.confidence, 'low');
});

test('匿名配送は番号を返さない', () => {
  // らくらくメルカリ便などは購入者に伝票番号が出ない。
  // ここで番号を返してしまうと、無関係な数字を追跡番号として書き込むことになる。
  const text = 'らくらくメルカリ便\n配送状況\n発送済み\n配達状況を確認する';
  assert.equal(extractTracking(text), null);
  assert.equal(extractStatus(text), '発送済み');
});

test('本文の表記が桁数より優先される', () => {
  // 12 桁はヤマトの形だが、本文にゆうパックとあれば日本郵便と判定する
  const got = extractTracking('ゆうパック\nお問い合わせ番号 : 123456789012');
  assert.equal(got.carrier, '日本郵便');
});

test('短すぎる数字は追跡番号として拾わない', () => {
  assert.equal(extractTracking('お問い合わせ番号 : 12345'), null);
  assert.equal(extractTracking(''), null);
  assert.equal(extractTracking(null), null);
});

test('配送状況を拾う', () => {
  assert.equal(extractStatus('取引完了'), '取引完了');
  assert.equal(extractStatus('配達完了しました'), '配達完了');
  assert.equal(extractStatus('なにもなし'), '');
});

test('各サイトの取引ページから商品IDを取り出す', () => {
  const cases = [
    ['メルカリ', '<a href="https://jp.mercari.com/item/m50204465032">', 'm50204465032'],
    ['ヤフオク', '<a href="https://page.auctions.yahoo.co.jp/jp/show/tradingnavi?aID=n1212071910&">', 'n1212071910'],
    ['ヤフオク', '<a href="https://page.auctions.yahoo.co.jp/jp/auction/v1212021835">', 'v1212021835'],
    ['ヤフフリ', '<a href="https://paypayfleamarket.yahoo.co.jp/item/z530177236">', 'z530177236'],
  ];
  for (const [site, html, id] of cases) {
    assert.equal(SITES[site].itemIdFrom(html), id, `${site}: ${html}`);
  }
});

test('商品IDが取れない場合は空文字を返す', () => {
  for (const name of Object.keys(SITES)) {
    assert.equal(SITES[name].itemIdFrom('<html>なにもない</html>'), '');
  }
});

test('未ログインのページを見分ける', () => {
  for (const name of Object.keys(SITES)) {
    assert.equal(SITES[name].loginCheck('ログインしてください'), false, name);
    assert.equal(SITES[name].loginCheck('購入した商品\n取引一覧'), true, name);
  }
});
