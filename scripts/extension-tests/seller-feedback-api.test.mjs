import test from 'node:test';import assert from 'node:assert/strict';
import {rpc} from '../../tools/fleamarket-extension/api.js';
test('評価専用RPCだけが認証付きで呼べ、失敗を自動再試行しない',async()=>{
 const oldFetch=globalThis.fetch,oldChrome=globalThis.chrome,calls=[];
 globalThis.chrome={storage:{local:{get:async()=>({session:{access_token:'test-local-token',expires_at:Date.now()/1000+3600}})}}};
 try{
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>[]};};
  await rpc('seller_feedback_candidates',{p_account_id:'mercari-2',p_ids:['m44757458628']});await rpc('seller_feedback_record',{p_action:'reserve'});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer test-local-token'));
  await assert.rejects(rpc('execute_sql',{}),/許可されていない/);assert.equal(calls.length,2);
  globalThis.fetch=async()=>{calls.push({failed:true});throw Error('Failed to fetch');};
  await assert.rejects(rpc('seller_feedback_record',{p_action:'begin'}),/Failed to fetch/);assert.equal(calls.length,3);
 }finally{globalThis.fetch=oldFetch;globalThis.chrome=oldChrome;}
});

test('日次発送RPCは認証付きで通し、通知予約の通信失敗を再送しない',async()=>{
 const oldFetch=globalThis.fetch,oldChrome=globalThis.chrome,calls=[];
 globalThis.chrome={storage:{local:{get:async()=>({session:{access_token:'test-local-token',expires_at:Date.now()/1000+3600}})}}};
 try{
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>[]};};
  await rpc('extension_daily_shipping_candidates',{p_account_ids:['mercari-1']});
  await rpc('extension_claim_daily_shipping_notice',{p_item_id:'fixture'});
  assert.equal(calls.length,2);assert(calls.every(c=>c.options.headers.Authorization==='Bearer test-local-token'&&c.options.headers['Content-Profile']==='app'));
  assert(calls[0].url.endsWith('/extension_daily_shipping_candidates'));assert(calls[1].url.endsWith('/extension_claim_daily_shipping_notice'));
  globalThis.fetch=async()=>{calls.push({failed:true});throw Error('Failed to fetch');};
  await assert.rejects(rpc('extension_claim_daily_shipping_notice',{}),/Failed to fetch/);assert.equal(calls.length,3);
  await assert.rejects(rpc('execute_sql',{}),/許可されていない/);assert.equal(calls.length,3);
 }finally{globalThis.fetch=oldFetch;globalThis.chrome=oldChrome;}
});
