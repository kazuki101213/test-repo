import test from 'node:test';
import assert from 'node:assert/strict';
import {drainRequestedListingBatch} from '../../tools/fleamarket-extension/operation-queue-recovery.js';
import {sellerQueuedOperations} from '../../tools/fleamarket-extension/seller-runtime.js';
const id='c5e83c17-5f2a-4392-941d-94ce0b49e012';
test('明示された同じ出品依頼だけ続行し、通常操作・失敗・結果不明では止まる',async()=>{
 for(const status of ['failed','uncertain','succeeded']){
  const calls=[];
  await drainRequestedListingBatch(async batch=>{calls.push(batch);return {processed:true,kind:'listing',status,listingBatchId:id,listingBatchPending:calls.length<3};});
  assert.deepEqual(calls,status==='succeeded'?[null,id,id]:[null]);
 }
 for(const kind of ['ship_notice','message_send','listing']){let count=0;await drainRequestedListingBatch(async()=>{count++;return {processed:true,kind,status:'succeeded',listingBatchPending:true};});assert.equal(count,1);}
 let bounded=0;await drainRequestedListingBatch(async()=>{bounded++;return {processed:true,kind:'listing',status:'succeeded',listingBatchId:id,listingBatchPending:true};});assert.equal(bounded,12);
});
test('続行要求は別batchの出品や発送コードを横取りしない',async()=>{
 for(const queue of [[{id:'other',kind:'listing',account_id:'mercari-2',payload:{listing_batch_id:'other'}}],[{id:'code',kind:'shipping_code',account_id:'mercari-2'}]]){
  let claims=0;await sellerQueuedOperations({listingBatchId:id,settings:{mode:'tracking',accounts:[{id:'mercari-2',site:'mercari',enabled:true}]},rpc:async name=>{if(name==='extension_seller_queue')return queue;claims++;return false;},openSession:async()=>assert.fail('別操作は実行しない'),log:async()=>{}});assert.equal(claims,0);
 }
});
