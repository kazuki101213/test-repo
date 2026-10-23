import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readBuyerTodoState} from '../../tools/fleamarket-extension/todo-audit.js';
import {sellerInspectionApplies,runSellerReadOnlyInspection} from '../../tools/fleamarket-extension/seller-inspection.js';
const profile='ba92b386-e0bc-48be-b3b6-ca9550fa1a2d',id='a1234567890';
const request=()=>({id:'25a3687d-f7ef-4a4a-b765-f14d8b9bc9c1',kind:'seller-readonly-structure',profiles:[profile],accountId:'auctions-1',buyerReceiptIds:[id],issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
test('buyer audit rejects other profiles, malformed IDs and mixed seller actions',()=>{
 const q=request();assert.equal(sellerInspectionApplies(q,profile,null),true);
 for(const change of [{buyerReceiptIds:['bad']},{buyerReceiptIds:Array(11).fill(id)},{targetSerial:'123'},{sellerListsOnly:true},{accountId:'mercari-1'}])assert.equal(sellerInspectionApplies({...q,...change},profile,null),false);
 assert.equal(sellerInspectionApplies(q,'f29f12b6-35f2-4e9f-8312-a8321ddf3c12',null),false);
});
test('buyer audit reads existing receipt/rating pages without invoking business operations or storing rating URL',async()=>{
 const data={},calls=[],rating='https://auctions.yahoo.co.jp/jp/show/leavefeedback?aID='+id;
 await runSellerReadOnlyInspection({settings:{accounts:[{id:'auctions-1',enabled:true,site:'auctions'}]},profileId:profile,storage:{get:async()=>data,set:async x=>Object.assign(data,x)},fetchRequest:async()=>request(),log:async()=>{},openSession:async()=>({structure:async()=>({}),go:async url=>calls.push(url),buyerTodo:async({stage})=>stage==='receipt'?{received:true,ratingUrl:rating}:{evaluated:true},operation:()=>{throw Error('NO SUBMISSION');},close:async()=>calls.push('restored')})});
 assert.equal(data.sellerInspectionEvidence.receipts[0].rating.evaluated,true);
 assert.equal(JSON.stringify(data.sellerInspectionEvidence).includes(rating),false);
 assert.deepEqual(calls,['https://contact.auctions.yahoo.co.jp/buyer/top?aid='+id,rating,'restored']);
});
test('listing audit matches requested serials beyond first eight samples without writing observations',async()=>{
 const data={},rows=Array.from({length:12},(_,i)=>({serial:String(i+1),external_id:'m'+i,status:'出品中'})),q={...request(),buyerReceiptIds:undefined,sellerListsOnly:true,listingSerials:['12']};
 await runSellerReadOnlyInspection({settings:{accounts:[{id:'auctions-1',enabled:true,site:'auctions'}]},profileId:profile,storage:{get:async()=>data,set:async x=>Object.assign(data,x)},fetchRequest:async()=>q,log:async()=>{},openSession:async()=>({structure:async()=>({}),go:async()=>{},links:async()=>[{text:'出品中',url:'https://auctions.yahoo.co.jp/my/selling'}],read:async()=>({rows,text:'',navigation:[]}),operation:()=>{throw Error('NO SUBMISSION');},close:async()=>{}})});
 assert.deepEqual(data.sellerInspectionEvidence.pages.find(p=>p.kind==='seller-list-only').requestedMatches,[rows[11]]);
});
test('DOM audit distinguishes pending receipt, completed receipt and previous evaluation; no clicks or field changes',async()=>{
 const require=createRequire(import.meta.url),{chromium}=require('C:/Users/長部一輝/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const p=await browser.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<main><p>受け取り連絡が完了しました</p><a href="https://auctions.yahoo.co.jp/jp/show/leavefeedback?aID='+id+'">出品者を評価する</a></main>'}));
  await p.goto('https://contact.auctions.yahoo.co.jp/buyer/top?aid='+id);await p.evaluate(()=>{document.addEventListener('click',()=>{throw Error('NO CLICK');});});
  const first=await p.evaluate(readBuyerTodoState,{itemId:id,stage:'receipt'});assert.equal(first.received,true,JSON.stringify({first,text:await p.locator('body').innerText()}));
  await p.evaluate(()=>{const a=document.createElement('a');a.href='#';a.textContent='受け取り連絡をする';document.querySelector('main').append(a);});
  const pending=await p.evaluate(readBuyerTodoState,{itemId:id,stage:'receipt'});assert.equal(pending.received,false);assert.equal(pending.pending,true);
  await p.unroute('**/*');await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<p>評価の変更 前回、評価した内容</p><input type="hidden" name="aID" value="'+id+'"><input type="hidden" name="isBuyer" value="true"><input type="hidden" name="isRevision" value="1"><textarea>既存値</textarea>'}));
  await p.goto('https://auctions.yahoo.co.jp/jp/show/leavefeedback?aID='+id);assert.equal((await p.evaluate(readBuyerTodoState,{itemId:id,stage:'rating'})).evaluated,true);assert.equal(await p.locator('textarea').inputValue(),'既存値');
  assert.ok((await p.evaluate(readBuyerTodoState,{itemId:'b1234567890',stage:'rating'})).__error);
 }finally{await browser.close();}
});
