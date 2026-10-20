import test from 'node:test';import assert from 'node:assert/strict';
import {sellerChoiceReady} from '../../tools/fleamarket-extension/seller-runtime.js';
test('発送する場所という見出しでも正しい経路・ラジオ・完了ボタンで認識する',()=>{
 const saved={location:globalThis.location,document:globalThis.document},radio={getClientRects:()=>[{}]},button={getClientRects:()=>[{}],innerText:'選択して完了する'};
 try{globalThis.location={hostname:'jp.mercari.com',pathname:'/transaction/m72106976118/shipping_facilities'};globalThis.document={querySelectorAll:s=>s==='input[type=radio]'?[radio]:s==='button'?[button]:[{getClientRects:()=>[{}],innerText:'発送する場所（２／２）'}]};assert.equal(sellerChoiceReady('shipping-place'),true);location.pathname='/transaction/m72106976118/shipping_class';assert.equal(sellerChoiceReady('shipping-place'),false);location.pathname='/transaction/m72106976118/shipping_facilities';radio.getClientRects=()=>[];assert.equal(sellerChoiceReady('shipping-place'),false);radio.getClientRects=()=>[{}];button.innerText='別の操作';assert.equal(sellerChoiceReady('shipping-place'),false);}finally{Object.assign(globalThis,saved);}
});
