import test from 'node:test';import assert from 'node:assert/strict';
import {yahooReceiptContactFlow} from '../../tools/fleamarket-extension/yahoo-workflow.js';
function fixture(fail){const calls=[];return {calls,args:{itemId:'a1234567890',contact:async({action})=>{calls.push(action);return action==='receive'?{received:true}:{url:'https://auctions.yahoo.co.jp/jp/show/leavefeedback?aID=a1234567890'};},go:async()=>calls.push('go'),settle:async()=>calls.push('settle'),assertEligible:async()=>{calls.push('eligible');if(fail==='eligibility')throw Error('条件変更');},rating:async({action})=>{calls.push(action);if(action==='buyerPreflight')return {buyer:true,seller:false,evaluated:false,newEvaluation:true};if(fail===action)return {error:'画面未確認'};return {previewRequested:true,comment:'ありがとうございました。',readyToPublish:true,publishRequested:true,submissionResult:true,success:true};}}};}
test('receipt-only workflow stops after verified receipt contact', async () => {
 const f=fixture();
 await yahooReceiptContactFlow(f.args);
 assert.deepEqual(f.calls,['eligible','receive']);
});

test('receipt-only workflow rechecks eligibility and never retries a contact click', async () => {
 const blocked=fixture('eligibility');
 await assert.rejects(yahooReceiptContactFlow(blocked.args),/条件変更/);
 assert.deepEqual(blocked.calls,['eligible']);
 const f=fixture();
 f.args.contact=async()=>{f.calls.push('receive');throw Error('Frame removed');};
 f.args.recoverReceived=async()=>{f.calls.push('readback');return {received:true};};
 await yahooReceiptContactFlow(f.args);
 assert.deepEqual(f.calls,['eligible','receive','readback']);
 f.args.recoverReceived=async()=>({received:false});
 await assert.rejects(yahooReceiptContactFlow(f.args),/完了を確認できません/);
});
