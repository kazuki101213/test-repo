import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerDaily} from '../../tools/fleamarket-extension/seller-runtime.js';
for(const mode of ['success','success-unchanged','unknown','ineligible'])test('daily lifecycle feedback -> financial reconciliation: '+mode,async()=>{
 const day='2026-10-22',id='m12345678901',account={id:'mercari-1',site:'mercari',enabled:true,label:'fixture'},events=[],data={};
 const row={external_id:id,serial:'123',status:'取引中',feedback_pending:true,detail_url:'https://jp.mercari.com/transaction/'+id};
 const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),set:async value=>Object.assign(data,value)};
 let finalObservation,reads=0;
 const rpc=async(name,args)=>{
  if(name==='extension_seller_daily_barrier')return true;
  if(name==='extension_daily_shipping_candidates')return [{account_id:account.id,item_id:'fixture',external_id:id,trade_key:'fixture',url:row.detail_url,receipt:null}];
  if(name==='extension_claim_daily_shipping_notice')return {id:'operation'};
  if(name==='extension_finish_seller_operation'){events.push('shipping');return true;}
  if(name==='seller_observation_plan')return [{external_id:id,action:mode==='success-unchanged'?'unchanged':'apply'}];
  if(name==='seller_feedback_candidates'){events.push('feedback-check');return mode==='ineligible'?[]:[{external_id:id,sku:'123-AA',trade_key:'fixture'}];}
  if(name==='seller_feedback_record'){events.push('feedback-'+args.p_action);return args.p_action==='reserve'?{claimed:true,token:'fixture'}:true;}
  if(name==='sync_seller_observation'){events.push('sales');finalObservation=args.p_observation;return 'updated';}
  throw Error(name);
 };
 const session={go:async()=>{},links:async()=>[{text:'取引中',url:'https://jp.mercari.com/mypage/listings/in_progress'}],read:async()=>{reads++;return {rows:[row],navigation:[],itemCount:1};},close:async()=>{},operation:async()=>({alreadyNotified:true,observed_at:'2026-10-22T01:00:00+09:00'}),loaded:async()=>{},feedback:async({action})=>{if(action==='inspect')return {ready:true};if(action==='prepare')return {prepared:true};if(action==='submit')return {submitRequested:true};if(action==='confirm')return {confirmationRequested:true};if(action==='result'){if(mode==='unknown')throw Error('unknown result');return {success:true};}return {};},detail:async()=>{events.push('final-detail');return {url:row.detail_url,text:'商品ID '+id+' 商品代金 10000 販売利益 7000 購入日時 2026/10/21 12:00'};}};
 await sellerDaily({settings:{mode:'tracking',purchaseImportEnabled:true,accounts:[account]},records:{scheduledRuns:{tracking:{day},purchases:{day}},lastRun:{tracking:{day},purchases:{day}}},day,profileId:'fixture',storage,rpc,openSession:async()=>session,log:async()=>{},now:Date.parse('2026-10-22T02:00:00Z'),feedbackSites:['mercari'],automaticShipping:true});
 assert.equal(reads,1);
 assert(events.includes('shipping'));assert(events.indexOf('shipping')<events.indexOf('feedback-check'));
 if(mode==='unknown'){assert(!events.includes('sales'));assert.equal(data.sellerDailyAttempt.status,'failed');assert.equal(data.sellerDailyAttempt.errors,1);}
 else{assert(events.indexOf('feedback-check')<events.indexOf('sales'));assert.equal(data.sellerDailyAttempt.status,'completed');if(mode.startsWith('success')){assert(events.indexOf('feedback-complete')<events.indexOf('final-detail'));assert.equal(finalObservation.status,'販売済');assert.equal(finalObservation.sold_price,10000);}else assert.equal(finalObservation.status,'取引中');}
});

test('販売情報だけの補修は発送通知も購入者評価も呼ばない',async()=>{const calls=[],account={id:'mercari-1',site:'mercari',enabled:true,label:'fixture'},day='2026-10-24';await sellerDaily({settings:{mode:'tracking',accounts:[account]},records:{},day,profileId:'fixture',storage:{get:async()=>({}),set:async()=>{}},rpc:async name=>{calls.push(name);return name==='seller_observation_plan'?[{external_id:'m12345678901',action:'unchanged'}]:[];},openSession:async()=>({links:async()=>[{text:'取引中',url:'https://jp.mercari.com/mypage/listings/in_progress'}],go:async()=>{},read:async()=>({rows:[{external_id:'m12345678901',status:'取引中',feedback_pending:true}],navigation:[],itemCount:1}),close:async()=>{}}),log:async()=>{},feedbackSites:['mercari'],automaticShipping:true,repair:{id:'fixture',accountId:account.id}});assert(!calls.includes('seller_feedback_candidates'));assert(!calls.includes('extension_daily_shipping_candidates'));assert(!calls.includes('extension_claim_daily_shipping_notice'));assert(!calls.includes('seller_feedback_record'));});
