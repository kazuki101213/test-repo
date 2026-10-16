import test from 'node:test';
import assert from 'node:assert/strict';
import {itemId,siteFor,assertSiteUrl,trackingNumbers,eligible,nextTime,dueTime,jstDay,settingsDefault,validateSettings} from '../../tools/fleamarket-extension/core.js';
test('サイトと商品IDを限定し、他サイト・偽ドメインを拒否',()=>{
  assert.equal(itemId('mercari','https://jp.mercari.com/transaction/m123456789'), 'm123456789');
  assert.equal(itemId('auctions','https://contact.auctions.yahoo.co.jp/buyer/top?aID=x123456'), 'x123456');
  assert.equal(itemId('flea','https://paypayfleamarket.yahoo.co.jp/item/z12345'), 'z12345');
  assert.equal(itemId('rakuma','https://item.fril.jp/0123456789abcdef0123456789abcdef'),'0123456789abcdef0123456789abcdef');
  assert.equal(siteFor('https://jp.mercari.com.evil.test/'),null);
  assert.equal(itemId('mercari','https://evil.test/item/m123'),null);
  assert.throws(()=>assertSiteUrl('mercari','http://jp.mercari.com/item/m123'));
});
test('追跡番号はラベル付きの数字だけ。複数は区別する',()=>{
  assert.deepEqual(trackingNumbers('商品価格 1234567890 追跡番号：1234-5678-9012 配送状況'),['123456789012']);
  assert.deepEqual(trackingNumbers('電話番号：09012345678'),[]);
  assert.equal(trackingNumbers('追跡番号：123456789012 配送 伝票番号：987654321098 お届け').length,2);
});
test('評価には購入者・未完了・在庫1件・検品と清掃の両方が必要',()=>{
  const item={sku:'test',inspected_at:'2026-10-04',cleaned_at:'2026-10-04'},tx={role:'buyer',state:'pending'};
  assert.equal(eligible([item],tx).ok,true);
  for(const items of [[],[item,item],[{...item,cleaned_at:null}],[{...item,inspected_at:null}]])assert.equal(eligible(items,tx).ok,false);
  assert.equal(eligible([item],{...tx,state:'completed'}).ok,false);
  assert.equal(eligible([item],{...tx,role:'seller'}).ok,false);
});
test('PCのタイムゾーンに依存せず日本時間の翌日を計算',()=>{
  const now=Date.parse('2026-10-04T01:00:00+09:00');
  assert.equal(jstDay(now),'2026-10-04');
  assert.equal(dueTime(2,now),Date.parse('2026-10-04T02:00:00+09:00'));
  assert.equal(nextTime(1,now),Date.parse('2026-10-05T01:00:00+09:00'));
});
test('同じChromeプロファイルへの同一サイト2アカウント登録を拒否',()=>{
  const s=settingsDefault();for(const a of s.accounts.slice(0,2)){a.enabled=true;a.listUrl='https://jp.mercari.com/mypage';a.identity={selector:'#me',text:'me'};}
  assert.throws(()=>validateSettings(s),/別Chromeプロファイル/);
  assert.equal(validateSettings(settingsDefault()).mode,'diagnostic');
});

test('ラクマの取引URLのitem_idを厳密に読み取る',()=>{
 const id='0123456789abcdef0123456789abcdef';
 assert.equal(itemId('rakuma','https://fril.jp/transaction?item_id='+id),id);
 assert.equal(itemId('rakuma','https://fril.jp/buy?item_id='+id),null);
 assert.equal(itemId('rakuma','https://fril.jp/transaction?item_id=invalid'),null);
 assert.equal(itemId('rakuma','https://evil.test/transaction?item_id='+id),null);
});

test('Yahoo!フリマの購入者取引ホストだけを許可する',()=>{
 assert.equal(siteFor('https://paypayfleamarket-sec.yahoo.co.jp/item/z12345/trade/buyer'),'flea');
 assert.equal(itemId('flea','https://paypayfleamarket-sec.yahoo.co.jp/item/z12345/trade/buyer'),'z12345');
 assert.equal(siteFor('https://paypayfleamarket-sec.yahoo.co.jp.evil.test/'),null);
 const s=settingsDefault();s.accounts[2].identity={selector:'header a',text:'Green',pageUrl:'https://auctions.yahoo.co.jp/my/won'};assert.doesNotThrow(()=>validateSettings(s));s.accounts[2].identity.pageUrl='https://contact.auctions.yahoo.co.jp/trade/top';assert.throws(()=>validateSettings(s));
});
