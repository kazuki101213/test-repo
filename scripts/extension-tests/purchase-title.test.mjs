import test from 'node:test';import assert from 'node:assert/strict';import {validPurchaseTitle} from '../../tools/fleamarket-extension/purchase-title.js';
test('通知文・未読件数・取引操作ラベルは商品名として保存しない',()=>{for(const t of ['取引メッセージがあります','新しい取引メッセージがあります','未読のメッセージがあります（2件）','取引メッセージが届いています','取引ナビ','取引連絡','発送待ち','受取連絡待ち','評価する'])assert.equal(validPurchaseTitle(t),false,t);});
test('空欄・文字以外・金額だけ・日付だけは商品名として保存しない',()=>{for(const t of [null,undefined,{},[],1700,'','   ','1,700円','￥ 1,700','2026/10/12 20:30','x'.repeat(501)])assert.equal(validPurchaseTitle(t),false,String(t));});
test('商品名中の送料・年代・メッセージ等は単独通知と区別して維持する',()=>{for(const t of ['動作確認済み【TOSHIBA】◆SE-R0466◆TV テレビリモコン 東芝','東芝 SE-R0434 中古品','SONY 2024年製 送料500円','メッセージボード 本体','商品説明: 発送待ち'])assert.equal(validPurchaseTitle(t),true,t);});
