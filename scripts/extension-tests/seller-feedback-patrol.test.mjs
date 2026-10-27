import test from 'node:test';import assert from 'node:assert/strict';
import {processSellerFeedback} from '../../tools/fleamarket-extension/seller-feedback.js';
import {sellerDaily} from '../../tools/fleamarket-extension/seller-runtime.js';
const account={id:'mercari-2',site:'mercari',label:'Mercari2',enabled:true},id='m20550299336',now=Date.parse('2026-10-27T13:00:00+09:00');
test('unsent preflight retries after four hours, while terminal and unknown never resend',async()=>{
 for(const state of ['checked','unknown','succeeded','skipped'])for(const age of [1,240]){
  const data={sellerFeedbackChecks:{['mercari-2:'+id]:{day:'2026-10-27',state,checkedAt:new Date(now-age*60000).toISOString()}}};let inspected=0,reserved=0;
  await processSellerFeedback({account,rows:[{external_id:id,feedback_pending:true,status:'\u53d6\u5f15\u4e2d'}],storage:{get:async k=>({[k]:data[k]}),set:async v=>Object.assign(data,v)},rpc:async(name,a)=>{if(name==='seller_feedback_candidates')return[{external_id:id,sku:'2394-EEMM',trade_key:id+':current'}];reserved++;return{};},log:async()=>{},now,session:{go:async()=>{},feedback:async()=>{inspected++;return{ready:false,deferred:true};}}});
  assert.equal(inspected,state==='checked'&&age===240?1:0);assert.equal(reserved,0);
 }
});
test('four-hour patrol uses the same list to preflight pending feedback without a second scan or a shipment notice',async()=>{
 for(const enabled of [true,false])for(const attention of [true,false]){
  const data={};let reads=0,inspected=0;const calls=[];
  const result=await sellerDaily({settings:{mode:'tracking',accounts:[account]},records:{},day:'2026-10-27',profileId:'profile',hourly:true,scheduledPatrol:true,now,feedbackSites:enabled?['mercari']:[],storage:{get:async k=>({[k]:data[k]}),set:async v=>Object.assign(data,v)},rpc:async(name,a)=>{calls.push(name);if(name==='seller_observation_plan')return a.p_rows.map(r=>({external_id:r.external_id,action:'unchanged'}));if(name==='seller_feedback_candidates')return[{external_id:id,sku:'2394-EEMM',trade_key:id+':current'}];throw Error('Unexpected RPC '+name);},log:async()=>{},openSession:async()=>({links:async()=>[{text:'\u53d6\u5f15\u4e2d',url:'https://jp.mercari.com/mypage/listings/in_progress'}],go:async()=>{},read:async()=>{reads++;return{rows:[{external_id:id,serial:'2394',status:'\u53d6\u5f15\u4e2d',feedback_pending:true,attention}],navigation:[],text:''};},feedback:async()=>{inspected++;return{ready:false,deferred:true};},close:async()=>{}})});
  assert.equal(reads,1);assert.equal(inspected,enabled&&!attention?1:0);assert(!calls.includes('extension_daily_shipping_candidates'));assert.equal(data.sellerHourlyAttempt.errors,0);
 }
});
