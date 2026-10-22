import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runOperationQueue} from '../../tools/fleamarket-extension/operation-queue-recovery.js';
import {sellerQueuedOperations} from '../../tools/fleamarket-extension/seller-runtime.js';
const memory=()=>{const data={};return {data,get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,value)};};
const log=async()=>{};
test('通信復旧確認は1・2・5・15分間隔、再起動後も期限を守り成功で解除する',async()=>{
 const storage=memory();let calls=0,now=1000000;
 const run=async()=>{calls++;throw Object.assign(new TypeError('Failed to fetch'),{rpcName:'extension_seller_queue',requestDiagnostic:{failure:'network',status:null,elapsedMs:5}});};
 for(const delay of [60000,120000,300000,900000,900000]){
  await runOperationQueue({scope:'seller',storage,run,log,now});
  assert.equal(storage.data.sellerQueueRecovery.nextAttemptAt,now+delay);
  const before=calls;
  await runOperationQueue({scope:'seller',storage,run,log,now:now+delay-1});assert.equal(calls,before);
  now+=delay;
 }
 await runOperationQueue({scope:'seller',storage,run:async()=>calls++,log,now});
 assert.equal(storage.data.sellerQueueRecovery.failures,0);assert.equal(storage.data.sellerQueueRecovery.nextAttemptAt,0);
});
test('仕入先の通信エラーが販売キュー取得を止めない、診断に秘密情報を含めない',async()=>{
 const storage=memory(),events=[];
 await runOperationQueue({scope:'supplier',storage,run:async()=>{throw Object.assign(new Error('Bearer secret-value'),{rpcName:'extension_supplier_queue',requestDiagnostic:{failure:'http',status:503,elapsedMs:40,token:'secret-value'}});},log:async(...e)=>events.push(e),now:10});
 let seller=0;await runOperationQueue({scope:'seller',storage,run:async()=>seller++,log,now:11});
 assert.equal(seller,1);assert.equal(storage.data.supplierQueueRecovery.rpc,'extension_supplier_queue');assert(!JSON.stringify({data:storage.data,events}).includes('secret-value'));
});
test('完了結果の通信消失後にキュー取得が復旧しても出品を再実行しない',async()=>{
 const storage=memory();let claimed=false,publishes=0,finished=0;
 const settings={mode:'tracking',accounts:[{enabled:true,id:'mercari-2',site:'mercari'}]};
 const job={id:'example-only',account_id:'mercari-2',kind:'listing',channel:'メルカリ',payload:{photos:[]}};
 const run=()=>sellerQueuedOperations({settings,log,rpc:async(name)=>{
  if(name==='extension_seller_queue')return claimed?[]:[job];
  if(name==='extension_claim_seller_operation'){claimed=true;return true;}
  if(name==='extension_finish_seller_operation'){finished++;throw Error('Failed to fetch');}
  throw Error(name);
 },openSession:async()=>({links:async()=>[{text:'出品',url:'https://jp.mercari.com/sell/create'}],go:async()=>{},structure:async()=>({fileInputs:[{}]}),loaded:async()=>{},operation:async(_,phase)=>{if(phase==='publish')publishes++;return phase==='listing_result'?{external_id:'m111'}:{};},close:async()=>{}})});
 await runOperationQueue({scope:'seller',storage,run,log,now:100});
 await runOperationQueue({scope:'seller',storage,run,log,now:60100});
 assert.equal(publishes,1);assert.equal(finished,1);assert.equal(storage.data.sellerQueueRecovery.failures,0);
});
test('旧当日停止フラグは新しいキュー取得を妨げない',async()=>{
 const storage=memory();storage.data.sellerQueueErrorDay='today';let calls=0;
 await runOperationQueue({scope:'seller',storage,run:async()=>calls++,log});assert.equal(calls,1);
 const source=await readFile(new URL('../../tools/fleamarket-extension/background.js',import.meta.url),'utf8');
 assert(!source.includes('sellerQueueErrorDay'));assert(source.includes("scope:'supplier'"));assert(source.includes("scope:'seller'"));
});
const {rpc}=await import('../../tools/fleamarket-extension/api.js');
for(const name of ['extension_seller_queue','extension_supplier_queue','extension_claim_seller_operation','extension_finish_seller_operation','extension_claim_supplier_operation','extension_finish_supplier_operation'])test(name+'は通信失敗を分類し、その場でリクエストを再送しない',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new TypeError('Failed to fetch');};
 try{await assert.rejects(rpc(name,{},'test-only-token'),e=>e.rpcName===name&&e.requestDiagnostic.failure==='network'&&e.requestDiagnostic.status===null);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
for(const [kind,response] of [
 ['timeout',async()=>{throw Object.assign(new Error('timeout'),{name:'TimeoutError'});}],
 ['http',async()=>({ok:false,status:503,json:async()=>({message:'Unavailable'})})],
 ['invalid_response',async()=>({ok:true,status:200,json:async()=>{throw Error('invalid JSON');}})]
])test('API障害分類 '+kind,async()=>{const original=globalThis.fetch;globalThis.fetch=response;try{await assert.rejects(rpc('extension_seller_queue',{},'test-only-token'),e=>e.requestDiagnostic.failure===kind);}finally{globalThis.fetch=original;}});
test('完了登録の204を通信エラー扱いしない',async()=>{const original=globalThis.fetch;globalThis.fetch=async()=>({ok:true,status:204});try{assert.equal(await rpc('extension_finish_seller_operation',{},'test-only-token'),null);}finally{globalThis.fetch=original;}});
