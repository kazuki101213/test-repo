import test from 'node:test';
import assert from 'node:assert/strict';
import {processDailyShipping,fetchCarrierReceipts} from '../../tools/fleamarket-extension/daily-shipping.js';
import {sellerDaily} from '../../tools/fleamarket-extension/seller-runtime.js';
for(const channel of ['メルカリ','ヤフオク'])for(const mode of ['unconfirmed','handoff','already','unknown','missing_confirmation','stale'])test(channel+' app handoff '+mode,async()=>{
 const job={item_id:'fixture',channel,account_id:channel==='メルカリ'?'mercari-2':'auctions-1',trade_key:channel==='メルカリ'?'m999999:2026-11-18':'a999999',url:'https://fixture',handoff_confirmed:mode!=='unconfirmed'};
 const phases=[],claims=[],finished=[],pages=[];
 const session={go:async u=>pages.push(u),operation:async(_,phase)=>{phases.push(phase);if(phase==='ship_notice_preflight')return{alreadyNotified:mode==='already',observed_at:new Date().toISOString()};if(mode==='unknown')throw Error('response lost');return mode==='missing_confirmation'?{}:{notified:true};},outboundReceipt:async()=>assert.fail('No waybill lookup')};
 const rpc=async(name,args)=>{if(name==='extension_claim_daily_shipping_notice'){claims.push(args);return mode==='stale'?null:{id:'operation'};}finished.push(args);};
 await processDailyShipping({jobs:[job],session,rpc,log:async()=>{},fetchReceipts:async()=>assert.fail('No carrier lookup')});
 if(mode==='unconfirmed'){assert.deepEqual(pages,[]);assert.deepEqual(claims,[]);return;}
 assert.equal(claims.length,1);
 if(mode==='stale'){assert.deepEqual(finished,[]);assert.deepEqual(phases,['ship_notice_preflight']);return;}
 assert.equal(finished[0].p_status,['unknown','missing_confirmation'].includes(mode)?'uncertain':'succeeded');
 if(mode==='already'){assert.deepEqual(phases,['ship_notice_preflight']);assert.equal(finished[0].p_result.already_notified,true);}
 else{assert.deepEqual(phases,['ship_notice_preflight','ship_notice']);assert.equal(claims[0].p_proof.source,'delivery_handoff');assert.equal(claims[0].p_proof.tracking_number,undefined);}
});
test('Daily handoffs run after account verification and before a failing listing scan',async()=>{
 const calls=[],day='2026-11-19',account={id:'mercari-2',site:'mercari',label:'fixture',enabled:true};
 const job={item_id:'fixture',account_id:account.id,channel:'メルカリ',trade_key:'mfixture:2026-11-18',url:'https://fixture',handoff_confirmed:true};
 const records={scheduledRuns:{tracking:{day},purchases:{day}},lastRun:{tracking:{day},purchases:{day}}};
 await sellerDaily({settings:{mode:'tracking',purchaseImportEnabled:true,accounts:[account]},records,day,now:Date.parse('2026-11-18T16:00:00Z'),automaticShipping:true,profileId:'fixture',storage:{set:async()=>{}},rpc:async(name)=>{calls.push(name);if(name==='extension_seller_daily_barrier')return true;if(name==='extension_daily_shipping_candidates')return[job];if(name==='extension_claim_daily_shipping_notice')return{id:'op'};return[];},openSession:async()=>{calls.push('verified');return{go:async()=>{},operation:async(_,phase)=>phase==='ship_notice_preflight'?{observed_at:new Date().toISOString()}:{notified:true},links:async()=>{calls.push('listing');throw Error('incomplete listing')},close:async()=>{}};},log:async()=>{}});
 assert(calls.indexOf('verified')<calls.indexOf('extension_claim_daily_shipping_notice'));
 assert(calls.indexOf('extension_finish_seller_operation')<calls.indexOf('listing'));
});
test('Carrier helper remains read-only and batches ten for unrelated receipt consumers',async()=>{
 const sizes=[],methods=[];await fetchCarrierReceipts({receipts:Array.from({length:11},(_,i)=>({carrier:'yamato',tracking_number:String(999999999900+i)})),pace:fn=>fn(),parse:async args=>{sizes.push(args.receipts.length);return[];},fetchPage:async(url,args)=>{methods.push(args);return{ok:true,headers:new Headers({'content-type':'text/html;charset=utf-8'}),arrayBuffer:async()=>new TextEncoder().encode('<h1>fixture</h1>').buffer};}});
 assert.deepEqual(sizes,[10,1]);assert(methods.every(v=>v.credentials==='omit'&&v.redirect==='error'));
});
