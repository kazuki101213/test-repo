import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/長部一輝/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const source=fs.readFileSync(new URL('../../tools/fleamarket-extension/content.js',import.meta.url),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});});
after(async()=>{await browser?.close();});
const account={id:'mercari-1',site:'mercari',identity:{selector:'#me',text:'購入者A'}};
async function fixture(html,url='https://jp.mercari.com/transaction/m123456789'){
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><header><span id="me">購入者A</span></header><main>'+html+'</main></body></html>'}));
  await page.goto(url);await page.evaluate(()=>{window.chrome={runtime:{id:'test',onMessage:{addListener:fn=>{window.listener=fn;}}}};});await page.addScriptTag({content:source});
  return page;
}
async function call(page,type,extra={}){return page.evaluate(({type,extra,account})=>new Promise(resolve=>window.listener({type:'fm:'+type,account,recipe:{scope:'main',listWaitMs:0,detailWaitMs:0},...extra},{id:'test'},resolve)),{type,extra,account});}
test('未完了の購入者取引から商品IDとラベル付き追跡番号を取得',async()=>{
  const p=await fixture('<h1>取引画面</h1><p>追跡番号：1234-5678-9012 配送</p><button>受取評価をする</button>');
  const r=await call(p,'detail');assert.equal(r.ok,true);assert.equal(r.value.itemId,'m123456789');assert.equal(r.value.role,'buyer');assert.equal(r.value.state,'pending');assert.equal(r.value.trackingNo,'123456789012');await p.close();
});
test('完了済み・出品者側・不明な画面を自動評価の対象にしない',async()=>{
  for(const [html,role,state] of [['<p>取引が完了しました</p><button>受取評価をする</button>','buyer','completed'],['<button>発送通知をする</button><button>受取評価をする</button>','seller','unknown'],['<h1>商品の情報</h1>','unknown','unknown']]){
    const p=await fixture(html);const r=await call(p,'detail');assert.equal(r.value.role,role);assert.equal(r.value.state,state);await p.close();
  }
});
test('アカウント変更と追加認証を検出して止める',async()=>{
  const p=await fixture('<button>受取評価をする</button>');await p.locator('#me').evaluate(e=>e.textContent='別アカウント');assert.equal((await call(p,'detail')).ok,false);await p.close();
  const q=await fixture('<input autocomplete="one-time-code">');assert.equal((await call(q,'detail')).value.auth,'追加承認待ち');assert.equal(await q.locator('input').inputValue(),'');await q.close();
});
test('購入一覧にある取引だけを取得、完了行と外部リンクを除外',async()=>{
  const p=await fixture('<h1>購入した商品</h1><ul><li><a href="/transaction/m123456789">取引中</a></li><li>取引完了<a href="/transaction/m987654321">完了分</a></li><li><a href="https://evil.test/transaction/m111">外部</a></li></ul>','https://jp.mercari.com/mypage/purchases');
  const r=await call(p,'list');assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://jp.mercari.com/transaction/m123456789']);await p.close();
});
test('未検証の評価レシピでは1回もクリックしない',async()=>{
  const p=await fixture('<form><label><input type="radio" name="rating" value="good">良かった</label><button type="button">受取評価をする</button></form>');await p.evaluate(()=>{window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;});
  assert.equal((await call(p,'submit',{itemId:'m123456789'})).ok,false);assert.equal(await p.evaluate(()=>window.clicks),0);await p.close();
});
test('検証済み評価フォームのみ、良い評価・必須コメント・受取確認を送信',async()=>{
  const p=await fixture('<form id="rating"><label><input id="good" type="radio" name="rating" value="good">良かった</label><label><input id="received" type="checkbox">商品を受け取りました</label><textarea id="comment" required></textarea><button id="submit" type="button">受取評価をする</button></form>');
  await p.evaluate(()=>{window.clicks=0;document.querySelector('#submit').onclick=()=>window.clicks++;});
  const recipe={scope:'main',receiptVerified:true,receiptScope:'#rating',positive:'#good',confirm:'#received',comment:'#comment',submit:'#submit',submitText:'受取評価をする',successText:'取引が完了しました'};
  const r=await call(p,'submit',{itemId:'m123456789',recipe});assert.equal(r.ok,true);assert.equal(await p.locator('#good').isChecked(),true);assert.equal(await p.locator('#received').isChecked(),true);assert.equal(await p.locator('#comment').inputValue(),'ありがとうございました。');assert.equal(await p.evaluate(()=>window.clicks),1);await p.close();
});
test('評価ボタンの差し替え・別商品ID・未知の必須欄を拒否',async()=>{
  for(const [button,expected,extra] of [['購入する','m123456789',''],['受取評価をする','m999',''],['受取評価をする','m123456789','<input required name="address">']]){
    const p=await fixture(`<form id="rating"><label><input id="good" type="radio">良かった</label>${extra}<button id="submit" type="button">${button}</button></form>`);await p.evaluate(()=>{window.clicks=0;document.querySelector('#submit').onclick=()=>window.clicks++;});
    const recipe={scope:'main',receiptVerified:true,receiptScope:'#rating',positive:'#good',submit:'#submit',submitText:'受取評価をする',successText:'完了'};
    assert.equal((await call(p,'submit',{itemId:expected,recipe})).ok,false);assert.equal(await p.evaluate(()=>window.clicks),0);await p.close();
  }
});

test('mainのないラクマ購入一覧は見出しを使うが名前確認は省略しない',async()=>{
 const id='0123456789abcdef0123456789abcdef';
 const p=await fixture('<div><h2>購入した商品</h2><a href="/transaction?item_id='+id+'">取引中</a></div>','https://fril.jp/buy');
 await p.locator('main').evaluate(e=>e.replaceWith(...e.childNodes));
 const account={id:'rakuma-1',site:'rakuma',identity:{selector:'#me',text:'購入者A'}};
 const r=await call(p,'list',{account,recipe:{}});
 assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://fril.jp/transaction?item_id='+id]);
 await p.locator('#me').evaluate(e=>e.remove());assert.equal((await call(p,'list',{account,recipe:{}})).ok,false);
 await p.close();
});

test('ラクマはマイページで一致を確認し、履歴側で未確認の読み取りを拒否する',async()=>{
 const a={id:'rakuma-1',site:'rakuma',identity:{selector:'#me',text:'Greenさんのマイページ',pageUrl:'https://fril.jp/mypage'}};
 const p=await fixture('<h2>マイページ</h2>','https://fril.jp/mypage');
 await p.locator('#me').evaluate(e=>e.textContent='Greenさんのマイページ');
 assert.equal((await call(p,'identity',{account:a})).value.confirmed,true);
 await p.locator('#me').evaluate(e=>e.textContent='別人さんのマイページ');
 assert.equal((await call(p,'identity',{account:{...a,_identityConfirmed:true}})).ok,false);await p.close();
 const q=await fixture('<div><h2>購入した商品</h2></div>','https://fril.jp/buy');
 await q.locator('main').evaluate(e=>e.replaceWith(...e.childNodes));
 assert.equal((await call(q,'list',{account:a,recipe:{}})).ok,false);
 assert.equal((await call(q,'list',{account:{...a,_identityConfirmed:true},recipe:{}})).ok,true);await q.close();
});

test('ラクマの自分のマイページから唯一の名前を自動取得し、認証画面や重複名を拒否する',async()=>{
 const p=await fixture('<h2>Greenさんのマイページ</h2>','https://fril.jp/mypage');
 const r=await call(p,'rakumaIdentity');assert.equal(r.ok,true);assert.equal(r.value.identity.text,'Greenさんのマイページ');assert.equal(r.value.identity.pageUrl,'https://fril.jp/mypage');
 await p.locator('main').evaluate(e=>e.insertAdjacentHTML('beforeend','<h2>他人さんのマイページ</h2>'));
 assert.equal((await call(p,'rakumaIdentity')).ok,false);await p.close();
 const q=await fixture('<input type="password"><h2>Greenさんのマイページ</h2>','https://fril.jp/mypage');assert.equal((await call(q,'rakumaIdentity')).ok,false);await q.close();
 const z=await fixture('<h2>Greenさんのマイページ</h2>','https://fril.jp/buy');assert.equal((await call(z,'rakumaIdentity')).ok,false);await z.close();
});

test('ポップアップは名前登録後も選択アカウントを保持しラクマを1ボタンで登録する',async()=>{
 const p=await browser.newPage();
 const base=new URL('../../tools/fleamarket-extension/',import.meta.url);
 await p.route('https://extension.test/**',route=>{
   const name=new URL(route.request().url()).pathname.slice(1);
   if(!['popup.html','popup.js','ui.js','core.js','style.css'].includes(name))return route.abort();
   return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8',body:fs.readFileSync(new URL(name,base),'utf8')});
 });
 await p.addInitScript(()=>{window.requests=[];window.chrome={runtime:{openOptionsPage:async()=>{},sendMessage:async m=>{
 window.requests.push(m);if(m.type==='state')return {ok:true,value:{connected:true,settings:{mode:'diagnostic',accounts:[{id:'mercari-1',label:'メルカリ1'},{id:'rakuma-1',label:'ラクマ1'}]}}};
 return {ok:true,value:{registered:true,label:'ラクマ1',name:'Greenさんのマイページ'}};
 }}};});
 await p.goto('https://extension.test/popup.html');await p.locator('#account option').nth(1).waitFor({state:'attached'});
 await p.selectOption('#account','rakuma-1');await p.click('#pick');await p.waitForFunction(()=>document.querySelector('#message').textContent==='アカウント名を紐付けました');
 assert.equal(await p.locator('#account').inputValue(),'rakuma-1');await p.click('#bind');await p.waitForFunction(()=>document.querySelector('#message').textContent==='購入一覧を登録しました');
 assert.equal((await p.evaluate(()=>window.requests.find(x=>x.type==='bind'))).id,'rakuma-1');
 await p.click('#autoRegister');await p.waitForFunction(()=>document.querySelector('#message').textContent.includes('ラクマ1 登録済み'));
 assert.equal(await p.locator('#account').inputValue(),'rakuma-1');assert.equal(await p.locator('#message').isVisible(),true);await p.click('#clearAccount');await p.waitForFunction(()=>document.querySelector('#message').textContent==='ラクマ1の名前と購入一覧の登録を削除しました');assert.equal((await p.evaluate(()=>window.requests.find(x=>x.type==='clearAccount'))).id,'rakuma-1');await p.close();
});

test('メルカリとYahoo!フリマは購入一覧のヘッダーから自分の名前だけを自動取得',async()=>{
 for(const [site,url] of [['mercari','https://jp.mercari.com/mypage/purchases'],['flea','https://paypayfleamarket.yahoo.co.jp/my/purchase']]){
  const p=await fixture('<h1>購入した商品</h1>',url);await p.locator('header').evaluate(e=>e.innerHTML='<a href="/mypage">siro</a>');
  const r=await call(p,'autoIdentity',{site});assert.equal(r.ok,true);assert.equal(r.value.identity.text,'siro');assert.equal(r.value.identity.pageUrl,url);
  const a={site,identity:r.value.identity};assert.equal((await call(p,'identity',{account:a})).value.confirmed,true);
  await p.locator('header').evaluate(e=>e.insertAdjacentHTML('beforeend','<a href="/user/profile/another">他人</a>'));
  assert.equal((await call(p,'autoIdentity',{site})).ok,false);assert.equal((await call(p,'identity',{account:a})).ok,false);await p.close();
 }
 const q=await fixture('<h1>購入した商品</h1><a href="/user/profile/seller">出品者名</a>','https://jp.mercari.com/mypage/purchases');assert.equal((await call(q,'autoIdentity',{site:'mercari'})).ok,false);await q.close();
});

test('メルカリはbodyの位置が変わってもヘッダーの本人名を確認し、別人や重複は止める',async()=>{
 const p=await fixture('<h1>購入した商品</h1>','https://jp.mercari.com/mypage/purchases');await p.locator('header').evaluate(e=>e.innerHTML='<button><div><p>siro</p></div></button>');
 const a={site:'mercari',identity:{selector:'body > div:nth-of-type(9) > header > button > div > p',text:'siro'}};
 assert.equal((await call(p,'list',{account:a})).ok,true);
 await p.locator('header p').evaluate(e=>e.textContent='別人');assert.equal((await call(p,'list',{account:a})).ok,false);
 await p.locator('header').evaluate(e=>e.innerHTML='<button><p>siro</p></button><button><p>siro</p></button>');assert.equal((await call(p,'list',{account:a})).ok,false);await p.close();
});

test('巡回結果のレポート画面はクリックなしで診断JSONを保存する',async()=>{
 const p=await browser.newPage();const base=new URL('../../tools/fleamarket-extension/',import.meta.url);
 await p.route('https://extension.test/**',route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!['report.html','report.js','ui.js','style.css'].includes(name))return route.abort();return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8',body:fs.readFileSync(new URL(name,base),'utf8')});});
 await p.addInitScript(()=>{window.chrome={runtime:{sendMessage:async m=>({ok:true,value:{version:'0.1.4',settings:{mode:'diagnostic'},events:[]}})},tabs:{getCurrent:async()=>({id:99}),remove:async()=>{}}};});
 const downloading=p.waitForEvent('download');await p.goto('https://extension.test/report.html');const file=await downloading;
 assert.match(file.suggestedFilename(),/^fleamarket-extension-[0-9]+-diagnostic.json$/);await p.waitForFunction(()=>document.querySelector('#result').textContent==='診断記録を保存しました');await p.close();
});

test('Yahoo!フリマの実際の購入者取引URLを一覧から取得する',async()=>{
 const p=await fixture('<h1>購入した商品</h1><a href="https://paypayfleamarket-sec.yahoo.co.jp/item/z12345/trade/buyer">取引画面</a>','https://paypayfleamarket.yahoo.co.jp/my/purchase');
 const a={site:'flea',identity:{selector:'#me',text:'購入者A'}};const r=await call(p,'list',{account:a});assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://paypayfleamarket-sec.yahoo.co.jp/item/z12345/trade/buyer']);await p.close();
});
test('ヤフオクは落札分の本人名を確認し、別人・重複・未確認取引ページを拒否する',async()=>{
 const p=await fixture('<h1>落札分</h1>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');
 const a={site:'auctions',identity:{selector:'body > div:nth-of-type(9) > header > p > a',text:'Green',pageUrl:'https://auctions.yahoo.co.jp/my/won'}};
 assert.equal((await call(p,'identity',{account:a})).value.confirmed,true);
 await p.locator('header a').evaluate(e=>e.textContent='別人');assert.equal((await call(p,'identity',{account:a})).ok,false);
 await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a><a>Green</a></p>');assert.equal((await call(p,'identity',{account:a})).ok,false);await p.close();
 const q=await fixture('<h1>取引画面</h1>','https://contact.auctions.yahoo.co.jp/trade/top');assert.equal((await call(q,'detail',{account:a})).ok,false);await q.close();
});
test('診断記録には取引の商品IDだけを残しユーザーIDを残さない',async()=>{
 const p=await fixture('<h1>落札分</h1><a href="https://contact.auctions.yahoo.co.jp/buyer/top?aid=m123&buyer_auc_user_id=PRIVATE&seller_auc_user_id=PRIVATE2">取引画面</a>','https://auctions.yahoo.co.jp/my/won');
 const r=await call(p,'diagnostic');assert.equal(r.ok,true);assert.equal(r.value.transactionLinks[0].url,'https://contact.auctions.yahoo.co.jp/buyer/top?aid=m123');assert.equal(JSON.stringify(r).includes('PRIVATE'),false);await p.close();
});

test('購入一覧は遅れて表示される取引を待ち、未表示と確認済み空一覧を区別する',async()=>{
 const p=await fixture('<h1>購入した商品</h1>','https://jp.mercari.com/mypage/purchases');await p.evaluate(()=>setTimeout(()=>{document.querySelector('main').insertAdjacentHTML('beforeend','<a href="/transaction/m123456789">取引画面</a>');},180));
 const r=await call(p,'list',{recipe:{scope:'main',listWaitMs:600}});assert.equal(r.ok,true);assert.equal(r.value.links.length,1);assert.equal(r.value.incomplete,undefined);await p.close();
 const q=await fixture('<h1>購入した商品</h1>','https://jp.mercari.com/mypage/purchases');assert.equal((await call(q,'list')).value.incomplete,true);await q.locator('main').evaluate(e=>e.insertAdjacentHTML('beforeend','<p>購入した商品はありません</p>'));assert.equal((await call(q,'list')).value.emptyConfirmed,true);await q.close();
});

test('複数商品の共通親に完了表示があっても別の取引を除外しない',async()=>{
 const p=await fixture('<h1>購入した商品</h1><div><a href="/transaction/m123456789">取引中</a><a href="/transaction/m987654321">取引完了</a></div>','https://jp.mercari.com/mypage/purchases');const r=await call(p,'list');assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://jp.mercari.com/transaction/m123456789','https://jp.mercari.com/transaction/m987654321']);await p.close();
});
test('メルカリの骨組み表示中は名前確認を急がず表示後に再確認する',async()=>{
 const p=await fixture('<h1>購入した商品</h1><div data-testid="items-skeleton"></div>','https://jp.mercari.com/mypage/purchases');await p.locator('#me').evaluate(e=>e.remove());await p.evaluate(()=>setTimeout(()=>{document.querySelector('header').innerHTML='<span id="me">購入者A</span>';document.querySelector('[data-testid="items-skeleton"]').remove();document.querySelector('main').insertAdjacentHTML('beforeend','<a href="/transaction/m123456789">取引画面</a>');},180));const r=await call(p,'list',{recipe:{scope:'main',listWaitMs:600}});assert.equal(r.ok,true);assert.equal(r.value.links.length,1);await p.close();
});

test('ラクマの見出しと取引一覧が兄弟領域でも購入一覧を限定する',async()=>{
 const id='0123456789abcdef0123456789abcdef';const p=await fixture('<section><div><h2>購入した商品</h2></div><div><a href="/transaction?item_id='+id+'">取引中</a></div></section><aside><a href="/transaction?item_id=ffffffffffffffffffffffffffffffff">別領域</a></aside>','https://fril.jp/buy');
 const a={site:'rakuma',identity:{selector:'#me',text:'購入者A'}};const r=await call(p,'list',{account:a});assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://fril.jp/transaction?item_id='+id]);await p.close();
});
test('メルカリの取引中フィルターは本人確認後に選択し購入操作をしない',async()=>{
 const p=await fixture('<h1>購入した商品</h1><label><input type="checkbox" data-testid="user-listing-inTransactionItemsCheckbox">取引中の商品</label><div id="items"><a href="/transaction/m111">完了分</a></div>','https://jp.mercari.com/mypage/purchases');
 await p.evaluate(()=>{document.querySelector('input').onchange=()=>{document.querySelector('#items').innerHTML='<a href="/transaction/m222">未完了分</a>';};});const r=await call(p,'list');assert.equal(r.ok,true);assert.deepEqual(r.value.links,['https://jp.mercari.com/transaction/m222']);assert.equal(await p.locator('input').isChecked(),true);
 await p.locator('input').uncheck();await p.locator('#me').evaluate(e=>e.textContent='別人');assert.equal((await call(p,'list')).ok,false);assert.equal(await p.locator('input').isChecked(),false);await p.close();
});
test('全行完了と取引中フィルターの空表示は未表示エラーと区別する',async()=>{
 const p=await fixture('<h1>購入した商品</h1><li>取引完了<a href="/transaction/m111">商品</a></li>','https://jp.mercari.com/mypage/purchases');const r=await call(p,'list');assert.equal(r.value.emptyConfirmed,true);assert.equal(r.value.incomplete,undefined);await p.close();
 const q=await fixture('<h1>購入した商品</h1><p>取引中の商品はありません</p>','https://jp.mercari.com/mypage/purchases');assert.equal((await call(q,'list')).value.emptyConfirmed,true);await q.close();
});
test('遅れて読み込まれる購入者取引の状態を待つ',async()=>{
 const p=await fixture('<h1>取引画面</h1>');await p.evaluate(()=>setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<button>受取評価をする</button>'),180));const r=await call(p,'detail',{recipe:{scope:'main',detailWaitMs:600}});assert.equal(r.value.role,'buyer');assert.equal(r.value.state,'pending');await p.close();
});

test('一覧が骨組み表示でも本人確認済みの取引中フィルターから取得を再開できる',async()=>{
 const p=await fixture('<h1>購入した商品</h1><input type="checkbox" data-testid="user-listing-inTransactionItemsCheckbox"><div data-testid="items-skeleton"></div>','https://jp.mercari.com/mypage/purchases');await p.evaluate(()=>{document.querySelector('input').onchange=()=>setTimeout(()=>{document.querySelector('[data-testid="items-skeleton"]').remove();document.querySelector('main').insertAdjacentHTML('beforeend','<a href="/transaction/m222">未完了分</a>');},180);});const r=await call(p,'list',{recipe:{listWaitMs:600}});assert.equal(r.value.links[0],'https://jp.mercari.com/transaction/m222');assert.equal(await p.locator('input').isChecked(),true);await p.close();
});

test('実画面のメルカリ購入者用受取確認と評価フォームから未完了を判定し、単なる評価ボタンでは判定しない',async()=>{
 const html='<div data-testid="transaction:information-for-buyer"><p>追跡番号：623036958471</p></div><form><input type="checkbox" data-testid="transaction:evaluation-item-received"><input type="radio" value="良かった"><button type="submit">評価を投稿する</button></form>';
 const p=await fixture(html);const r=await call(p,'detail');assert.equal(r.value.role,'buyer');assert.equal(r.value.state,'pending');assert.equal(r.value.trackingNo,'623036958471');assert.equal(await p.locator('input[type="checkbox"]').isChecked(),false);await p.close();
 for(const body of [html.replace('information-for-buyer','information-for-seller'),'<button type="submit">評価を投稿する</button>']){const q=await fixture(body);const r=await call(q,'detail');assert.equal(r.value.role,'unknown');assert.equal(r.value.state,'unknown');await q.close();}
 const q=await fixture(html+'<p>取引が完了しました</p>');assert.equal((await call(q,'detail')).value.state,'completed');await q.close();
});

test('購入者フォームが先に表示されても追跡番号の遅延表示を待つ',async()=>{
 const p=await fixture('<button>受取評価をする</button>');await p.evaluate(()=>setTimeout(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<p>追跡番号：623036958471</p>'),180));const r=await call(p,'detail',{recipe:{scope:'main',detailWaitMs:600}});assert.equal(r.value.trackingNo,'623036958471');assert.equal(r.value.role,'buyer');await p.close();
});

test('専用検証画面は本人確認して取引を読むだけで評価・更新・既存タブ閉鎖を行わない',async()=>{
 const p=await browser.newPage(),base=new URL('../../tools/fleamarket-extension/',import.meta.url);await p.route('https://extension.test/**',route=>{const name=new URL(route.request().url()).pathname.slice(1);return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/html; charset=utf-8',body:fs.readFileSync(new URL(name,base),'utf8')});});
 await p.addInitScript(()=>{let id=100;window.requests=[];window.auditClosed=[];window.auditCreated=[];window.chrome={runtime:{sendMessage:async m=>{window.requests.push(m.type);return{ok:true,value:{version:'0.1.16',profileId:'test',settings:{accounts:[{enabled:true,id:'flea-1',label:'Yahoo!フリマ1',site:'flea',listUrl:'https://paypayfleamarket.yahoo.co.jp/my/purchase',identity:{selector:'#me',text:'Green'}}]}}};}},tabs:{create:async x=>{window.auditCreated.push(++id);return{id};},get:async()=>({status:'complete'}),remove:async x=>window.auditClosed.push(x),sendMessage:async(id,m)=>{window.requests.push(m.type);return{ok:true,value:m.type==='fm:list'?{links:['https://paypayfleamarket-sec.yahoo.co.jp/item/z123/trade/buyer']}:m.type==='fm:diagnostic'?{headings:[]}: {role:'buyer',state:'pending',itemId:'z123'}};}},scripting:{executeScript:async()=>{}}};});await p.goto('https://extension.test/verify.html');await p.waitForFunction(()=>document.querySelector('#status').textContent==='読み取り検証が終了しました。',{},{timeout:10000});const r=await p.evaluate(()=>({requests:window.requests,closed:window.auditClosed,created:window.auditCreated}));assert.deepEqual(new Set(r.closed),new Set(r.created));assert.equal(r.requests.some(x=>/submit|preflight|start|stop|save|connect/.test(x)),false);assert.ok(r.requests.includes('fm:detail'));await p.close();
});

test('Yahoo!フリマは保存した購入一覧の登録名を確認し、別名・別URLでは停止する',async()=>{
 const a={id:'flea-1',site:'flea',identity:{pageUrl:'https://paypayfleamarket.yahoo.co.jp/my/purchase',selector:'#me',text:'購入者A'}};
 const p=await fixture('<h1>購入した商品</h1>','https://paypayfleamarket.yahoo.co.jp/my/purchase');
 assert.equal((await call(p,'identity',{account:a})).ok,true);
 assert.equal((await call(p,'identity',{account:{...a,identity:{...a.identity,text:'別人'}}})).ok,false);
 await p.close();
 const q=await fixture('<h1>取引</h1><button>受取評価をする</button><p>追跡番号：123456789012</p>','https://paypayfleamarket-sec.yahoo.co.jp/item/z12345/trade/buyer');
 assert.equal((await call(q,'detail',{account:a})).ok,false);
 const r=await call(q,'detail',{account:{...a,_identityConfirmed:true}});assert.equal(r.value.itemId,'z12345');assert.equal(r.value.role,'buyer');assert.equal(r.value.trackingNo,'123456789012');await q.close();
});

test('在庫先行では完了済みも一覧照合し、商品IDと購入日を行単位で読み取る',async()=>{const p=await fixture('<h1>購入した商品</h1><ul><li><a href="/transaction/m123456789">商品A</a><time datetime="2026-10-03T12:00:00+09:00">2026/10/03</time><span>取引完了</span></li><li><a href="/transaction/m987654321">商品B</a><time datetime="2026-08-03">2026/08/03</time></li></ul>','https://jp.mercari.com/mypage/purchases');const r=await call(p,'list',{recipe:{inventoryFirst:true,includeCompleted:true,listWaitMs:0}});assert.equal(r.ok,true);assert.deepEqual(r.value.inventoryRows.map(x=>[x.itemId,x.purchasedAt]),[['m123456789','2026-10-03'],['m987654321','2026-08-03']]);await p.close();});

test('旧メルカリ登録の確認URL未保存でも購入一覧で本人名を確認し、別名は拒否する',async()=>{const p=await fixture('<h1>購入した商品</h1>','https://jp.mercari.com/mypage/purchases');await p.locator('header').evaluate(e=>e.innerHTML='<button><p>siro</p></button>');const a={site:'mercari',listUrl:'https://jp.mercari.com/mypage/purchases',identity:{selector:'body > header > button > p',text:'siro'}};const good=await call(p,'identity',{account:a});assert.equal(good.ok,true,good.error);assert.equal(good.value.confirmed,true);await p.locator('header p').evaluate(e=>e.textContent='別人');assert.equal((await call(p,'identity',{account:a})).ok,false);await p.close();});

test('ヤフオクの落札一覧の月日と時刻を日本時間の年付き日付へ読み取り、商品名の日付を無視する',async()=>{const p=await fixture('<h1>落札分</h1><ul><li><a href="/jp/auction/b123">SONY 2020/1/1 限定モデル</a><span>12/31 22:10</span><span>商品ID：b123</span></li><li><a href="/jp/auction/c123">SHARP</a><span>1/3 21:10</span></li></ul>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const a={site:'auctions',identity:{selector:'header p > a',text:'Green'}};const r=await call(p,'list',{account:a,recipe:{includeCompleted:true,inventoryFirst:true,referenceDay:'2026-01-05'}});assert.equal(r.ok,true,r.error);assert.deepEqual(r.value.inventoryRows.map(x=>x.purchasedAt),['2025-12-31','2026-01-03']);await p.close();});
test('ヤフオクの落札日が複数候補なら日付を推測せず未確定にする',async()=>{const p=await fixture('<h1>落札分</h1><li><a href="/jp/auction/b123">SONY</a><span>10/5 22:10</span><span>10/4 22:10</span></li>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const r=await call(p,'list',{account:{site:'auctions',identity:{selector:'header p > a',text:'Green'}},recipe:{includeCompleted:true,inventoryFirst:true,referenceDay:'2026-10-06'}});assert.equal(r.ok,true,r.error);assert.equal(r.value.inventoryRows[0].purchasedAt,null);await p.close();});

test('仕入れ取得はメルカリ購入日の実形式を使い、商品名中の年や金額を使わない',async()=>{
 const p=await fixture('<h1>購入した商品</h1><ul><li><a href="/item/m123456789"><h3>SONY 2024年製 送料500円</h3><p>2026/09/29 09:39</p></a></li></ul>','https://jp.mercari.com/mypage/purchases');
 const r=await call(p,'list',{recipe:{purchaseImport:true,includeCompleted:true,referenceDay:'2026-10-07',listWaitMs:0}});assert.equal(r.ok,true);assert.equal(r.value.purchaseRows.length,1);assert.equal(r.value.purchaseRows[0].purchased_at,'2026-09-29');assert.equal(r.value.purchaseRows[0].cost_amount,null);assert.equal(r.value.purchaseRows[0].title,'SONY 2024年製 送料500円');await p.close();
});
test('購入取得のヤフオクは完了履歴を含め、別商品を含む共通親とおすすめ商品を除外',async()=>{
 const p=await fixture('<h1>落札分</h1><ul><li><a href="/jp/auction/b123">SONY ABC</a><p>取引が完了しました 商品ID：b123</p><span>8,500円</span><span>10/5 22:27</span></li><li><a href="/jp/auction/b999">おすすめ商品</a><span>1,200円</span></li></ul>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');
 const r=await call(p,'list',{account:{site:'auctions',identity:{text:'Green'}},recipe:{purchaseImport:true,includeCompleted:true,referenceDay:'2026-10-07',listWaitMs:0}});assert.equal(r.ok,true);assert.equal(r.value.purchaseRows.length,1);assert.equal(r.value.purchaseRows[0].purchased_at,'2026-10-05');assert.equal(r.value.purchaseRows[0].cost_amount,8500);await p.close();
});
test('購入詳細はラベル付き金額だけを読み、不明日付は推測しない',async()=>{
 const p=await fixture('<p>商品代金</p><p>¥ 1,980</p><p>送料</p><p>¥ 500</p><button>受取評価をする</button>');const r=await call(p,'purchaseDetail',{itemId:'m123456789'});assert.equal(r.value.cost_amount,1980);assert.equal(r.value.purchased_at,null);await p.close();
});

test('Yahoo!フリマは共通一覧親ではなく各購入カードを分け、年月日形式とキャンセルを読む',async()=>{const p=await fixture('<h1>購入した商品</h1><div><a href="https://paypayfleamarket-sec.yahoo.co.jp/item/z123/trade/buyer"><p>SONY UBP-X700</p><p>2026年9月29日 15:26</p><span>取引完了</span></a><a href="https://paypayfleamarket-sec.yahoo.co.jp/item/z124/trade/buyer"><p>SHARP 2B-C10DT1</p><p>2026年9月28日 12:10</p><span>取引キャンセル</span></a></div>','https://paypayfleamarket.yahoo.co.jp/my/purchase');const a={site:'flea',listUrl:'https://paypayfleamarket.yahoo.co.jp/my/purchase',identity:{selector:'#me',text:'購入者A'}};assert.equal((await call(p,'identity',{account:a})).ok,true);const r=await call(p,'list',{account:a,recipe:{purchaseImport:true,includeCompleted:true,listWaitMs:0}});assert.equal(r.ok,true,r.error);assert.equal(r.value.purchaseRows.length,2);assert.equal(r.value.purchaseRows[0].purchased_at,'2026-09-29');assert.equal(r.value.purchaseRows[0].title,'SONY UBP-X700');assert.equal(r.value.purchaseRows[1].cancelled,true);await p.close();});
test('ヤフオクの数字と円が分割された金額を読み、支払案内を商品名にしない',async()=>{const p=await fixture('<h1>落札分</h1><li><p>出品者に連絡してください</p><p>かんたん決済支払期限：あと4日</p><a href="/jp/auction/b123">SONY UBP-X700</a><p>14,000<span>円</span></p><span>10/6 22:49</span><span>商品ID：b123</span></li>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const r=await call(p,'list',{account:{site:'auctions',identity:{text:'Green'}},recipe:{purchaseImport:true,includeCompleted:true,referenceDay:'2026-10-07',listWaitMs:0}});assert.equal(r.value.purchaseRows[0].cost_amount,14000);assert.equal(r.value.purchaseRows[0].title,'SONY UBP-X700');await p.close();});

test('ラクマの新しい詳細画面は商品リンクと金額の遅延表示を待ち、別商品は拒否する',async()=>{const id='0123456789abcdef0123456789abcdef';const p=await fixture('<p>読み込み中</p>','https://web.fril.jp/v2/purchase/item');await p.evaluate(id=>setTimeout(()=>document.querySelector('main').innerHTML='<a href="https://item.fril.jp/'+id+'">商品</a><p>商品代金</p><p>1,980円</p>',150),id);const a={site:'rakuma',identity:{pageUrl:'https://fril.jp/mypage',selector:'#me',text:'購入者A'},_identityConfirmed:true};const r=await call(p,'purchaseDetail',{account:a,itemId:id,recipe:{detailWaitMs:1000}});assert.equal(r.ok,true,r.error);assert.equal(r.value.cost_amount,1980);assert.equal(r.value.purchased_at,null);await p.close();const q=await fixture('<a href="https://item.fril.jp/ffffffffffffffffffffffffffffffff">別商品</a>','https://web.fril.jp/v2/purchase/item');assert.equal((await call(q,'purchaseDetail',{account:a,itemId:id,recipe:{detailWaitMs:0}})).ok,false);await q.close();});
test('ラクマ数字IDは正規移動だけ採用し完了日は購入日と混同しない',async()=>{
 const id='3713a6643c66db11d75ee7c01f0553fc',url='https://web.fril.jp/v2/purchase/item?is_web=1&item_id=849503301';const p=await fixture('<p>取引完了日:2026年09月06日</p><p>商品代金：4,500円</p>',url);const a={site:'rakuma',identity:{selector:'#me',text:'購入者A'}};const navigation={requestedUrl:'https://fril.jp/transaction?item_id='+id,finalUrl:url};const r=await call(p,'purchaseDetail',{account:a,itemId:id,recipe:{detailWaitMs:0,navigation}});assert.equal(r.ok,true);assert.equal(r.value.purchased_at,null);assert.equal(r.value.purchaseBeforeOrOn,'2026-09-06');for(const n of [undefined,{...navigation,requestedUrl:'https://fril.jp/transaction?item_id='+'a'.repeat(32)},{...navigation,finalUrl:url+'0'}]){const failed=await call(p,'purchaseDetail',{account:a,itemId:id,recipe:{detailWaitMs:0,navigation:n}});assert.equal(failed.ok,false);assert.match(failed.error,/商品IDが一致しません/);}await p.close();
});
test('ヤフオクのストア取引auctionIdと個人取引aidの実リンクを同じ行の商品IDに照合する',async()=>{const p=await fixture('<h1>落札分</h1><ul><li><a href="/jp/auction/d1246319424">商品A</a><a href="https://buy.auctions.yahoo.co.jp/order/status?auctionId=d1246319424">取引連絡</a><span>10/8 21:10</span></li><li><a href="/jp/auction/k1246920217">商品B</a><a href="https://contact.auctions.yahoo.co.jp/trade/top?aid=k1246920217&amp;oid=fixture">取引連絡</a><span>10/8 20:10</span></li></ul>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const a={site:'auctions',identity:{selector:'header p > a',text:'Green'}};const r=await call(p,'list',{account:a,recipe:{includeCompleted:true,inventoryFirst:true,referenceDay:'2026-10-09',listWaitMs:0}});assert.equal(r.ok,true,r.error);assert.equal(r.value.inventoryRows[0].url,'https://buy.auctions.yahoo.co.jp/order/status?auctionId=d1246319424');assert.equal(r.value.inventoryRows[1].url,'https://contact.auctions.yahoo.co.jp/trade/top?aid=k1246920217&oid=fixture');await p.close();});
test('ストアの購入者取引画面ではauctionIdで同一商品を確定して伝票番号を読む',async()=>{const p=await fixture('<a href="https://page.auctions.yahoo.co.jp/jp/auction/d1246319424">商品</a><p>伝票番号：123456789012</p>','https://buy.auctions.yahoo.co.jp/order/status?auctionId=d1246319424');const r=await call(p,'detail',{account:{site:'auctions',identity:{pageUrl:'https://auctions.yahoo.co.jp/my/won',text:'Green'},_identityConfirmed:true}});assert.equal(r.ok,true,r.error);assert.equal(r.value.itemId,'d1246319424');assert.equal(r.value.trackingNo,'123456789012');await p.close();});
test('mainタグのない実ストア形式も購入者確認とauctionId一致後だけ番号を読む',async()=>{const p=await fixture('<a href="https://page.auctions.yahoo.co.jp/jp/auction/d1246319424">商品</a><p>お問い合わせ伝票番号：123456789012</p>','https://buy.auctions.yahoo.co.jp/order/status?auctionId=d1246319424');await p.locator('main').evaluate(e=>e.replaceWith(...e.childNodes));const a={site:'auctions',identity:{pageUrl:'https://auctions.yahoo.co.jp/my/won',text:'Green'},_identityConfirmed:true};const r=await call(p,'detail',{account:a});assert.equal(r.ok,true,r.error);assert.equal(r.value.trackingNo,'123456789012');await p.evaluate(()=>{const e=document.createElement('a');e.href='https://page.auctions.yahoo.co.jp/jp/auction/e1246378580';e.textContent='別商品';document.body.append(e);});assert.equal((await call(p,'detail',{account:a})).ok,false);await p.close();});
test('公開商品ページのmain欠落や複数mainにはストア用の読取例外を適用しない',async()=>{const a={site:'auctions',identity:{pageUrl:'https://auctions.yahoo.co.jp/my/won',text:'Green'},_identityConfirmed:true};for(const u of ['https://auctions.yahoo.co.jp/jp/auction/d1246319424','https://buy.auctions.yahoo.co.jp/order/status?auctionId=d1246319424']){const p=await fixture('<p>伝票番号：123456789012</p>',u);if(u.includes('/jp/auction/'))await p.locator('main').evaluate(e=>e.remove());else await p.evaluate(()=>document.body.append(document.createElement('main')));const r=await call(p,'detail',{account:a});assert.equal(r.ok,false);await p.close();}});
test('ヤフオクの画像リンクの通知titleと通知見出しより、同一IDの商品名リンクの文字を優先する',async()=>{const p=await fixture('<h1>落札分</h1><ul><li><span class="message-title">取引メッセージがあります</span><a href="/jp/auction/q1246533097" title="取引メッセージがあります"><img alt="商品画像"></a><a href="/jp/auction/q1246533097" title="取引メッセージがあります">SONY BDZ-FW1000 本体</a><a href="https://contact.auctions.yahoo.co.jp/buyer/top?aid=q1246533097">取引連絡</a><span>1,700円</span><span>10/12 20:00</span></li></ul>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const r=await call(p,'list',{account:{site:'auctions',identity:{text:'Green'}},recipe:{purchaseImport:true,includeCompleted:true,referenceDay:'2026-10-13',listWaitMs:0}});assert.equal(r.ok,true,r.error);assert.equal(r.value.purchaseRows[0].title,'SONY BDZ-FW1000 本体');assert.equal(r.value.purchaseRows[0].cost_amount,1700);await p.close();});
test('ヤフオクは通知だけなら商品名を推測せず、別商品の見出しや取引ボタンを採用しない',async()=>{const p=await fixture('<h1>落札分</h1><ul><li><h3>取引メッセージがあります</h3><a href="/jp/auction/q1246533097" title="取引メッセージがあります"><img alt="商品画像"></a><a href="https://contact.auctions.yahoo.co.jp/buyer/top?aid=q1246533097" title="他の案内">取引連絡</a><span>10/12 20:00</span></li></ul>','https://auctions.yahoo.co.jp/my/won');await p.locator('header').evaluate(e=>e.innerHTML='<p><a>Green</a></p>');const r=await call(p,'list',{account:{site:'auctions',identity:{text:'Green'}},recipe:{purchaseImport:true,includeCompleted:true,referenceDay:'2026-10-13',listWaitMs:0}});assert.equal(r.ok,true,r.error);assert.equal(r.value.purchaseRows[0].title,null);await p.close();});
