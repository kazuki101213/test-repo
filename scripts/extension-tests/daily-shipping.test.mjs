import test from 'node:test';
import assert from 'node:assert/strict';
import {processDailyShipping,fetchCarrierReceipts} from '../../tools/fleamarket-extension/daily-shipping.js';
const receipt={carrier:'yamato',tracking_number:'999999999999'},proof={...receipt,accepted:true,accepted_at:'2026-10-22T09:00:00+09:00',observed_at:'2026-10-22T09:01:00+09:00'};
const job={item_id:'fixture',external_id:'m99999999999',trade_key:'m99999999999:2026-10-21',url:'https://jp.mercari.com/transaction/m99999999999',receipt};
for(const mode of ['accepted','unaccepted','already','changed','uncertain'])test('daily shipping '+mode,async()=>{
 const calls=[],phases=[],pages=[];let fetched=0;
 const session={go:async u=>pages.push(u),operation:async(_,phase)=>{phases.push(phase);if(phase==='ship_notice_preflight')return mode==='already'?{alreadyNotified:true,observed_at:proof.observed_at}:{};if(mode==='uncertain')throw Error('confirmation unknown');return {notified:true};},outboundReceipt:async()=>mode==='changed'?{...receipt,tracking_number:'888888888888'}:receipt};
 const rpc=async(name,args)=>{calls.push({name,args});return name==='extension_claim_daily_shipping_notice'?{...job,id:'operation',payload:{automatic_receipt:proof}}:true;};
 await processDailyShipping({jobs:[mode==='already'?{...job,receipt:null}:job],session,rpc,log:async()=>{},fetchReceipts:async()=>{fetched++;return new Map(mode==='unaccepted'?[]:[['yamato:'+receipt.tracking_number,proof]]);}});
 const finish=calls.find(c=>c.name==='extension_finish_seller_operation');
 if(mode==='unaccepted'){assert.equal(calls.length,0);assert.equal(pages.length,0);return;}
 if(mode==='already'){assert.equal(fetched,0);assert(!phases.includes('ship_notice'));assert.equal(finish.args.p_result.already_notified,true);}
 if(mode==='changed'){assert(!phases.includes('ship_notice'));assert.equal(finish.args.p_status,'failed');}
 if(mode==='uncertain')assert.equal(finish.args.p_status,'uncertain');
 if(mode==='accepted'){assert.equal(phases.filter(v=>v==='ship_notice').length,1);assert.equal(finish.args.p_status,'succeeded');}
});
test('carrier lookup batches ten, omits cookies, never retries a failed request',async()=>{
 const sizes=[],methods=[];let count=0;
 await fetchCarrierReceipts({receipts:Array.from({length:11},(_,i)=>({...receipt,tracking_number:String(999999999900+i)})),pace:fn=>fn(),parse:async args=>{sizes.push(args.receipts.length);return [];},fetchPage:async(url,args)=>{count++;methods.push(args);return {ok:true,headers:new Headers({'content-type':'text/html;charset=utf-8'}),arrayBuffer:async()=>new TextEncoder().encode('<h1>tracking</h1>').buffer};}});
 assert.deepEqual(sizes,[10,1]);assert.equal(count,2);assert(methods.every(v=>v.credentials==='omit'&&v.redirect==='error'));
 count=0;await assert.rejects(fetchCarrierReceipts({receipts:[receipt],pace:fn=>fn(),parse:async()=>[],fetchPage:async()=>{count++;throw Error('offline');}}));assert.equal(count,1);
});
