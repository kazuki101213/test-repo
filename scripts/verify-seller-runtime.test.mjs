import test from 'node:test';import assert from 'node:assert/strict';
import {sellerScheduleReady,sellerAccounts,sellerTarget,parseSellerSaleDetail,sellerUrl} from '../tools/fleamarket-extension/seller-sync.js';
import {sellerDaily,sellerQueuedOperations,openSellerSession} from '../tools/fleamarket-extension/seller-runtime.js';
const day='2026-10-16',settings={mode:'tracking',purchaseImportEnabled:true,accounts:[{id:'mercari-2',site:'mercari',label:'メルカリ2',enabled:true},{id:'mercari-1',site:'mercari',enabled:true},{id:'auctions-1',site:'auctions',label:'ヤフオク1',enabled:true}]};
const records=()=>({scheduledRuns:{tracking:{day},purchases:{day}},lastRun:{tracking:{day},purchases:{day}}});
test('既存01時の全処理が完了するまで販売確認を開始せず、その日は1回だけ',()=>{assert.equal(sellerScheduleReady(settings,records(),day),true);for(const modified of [{...records(),job:{}},{...records(),lastRun:{}},{...records(),sellerDailyAttempt:{day,status:'failed'}}])assert.equal(sellerScheduleReady(settings,modified,day),false);assert.equal(sellerScheduleReady({...settings,mode:'diagnostic'},records(),day),false);assert.deepEqual(sellerAccounts(settings).map(a=>a.id),['mercari-2','mercari-1','auctions-1']);});
test('一覧の10/11を販売日にせず、明細の10/8と決済金額・受取金額を使う',()=>{const value=parseSellerSaleDetail('ヤフオク','受け取り明細 商品ID：u1247165686 取扱日：2026/10/11 取引日：2026/10/08 20:14 受取金額：4,371円 決済金額：6,100円 落札システム利用料：-449円 送料：-1,280円','u1247165686');assert.equal(value.sold_on,'2026-10-08');assert.equal(value.sold_price,6100);assert.equal(value.payout_amount,4371);assert.equal(value.trade_key,'u1247165686:2026-10-08T20:14');});
test('メルカリの購入日時・商品代金・販売利益をそのまま取得する',()=>{const value=parseSellerSaleDetail('メルカリ','商品代金 ¥31,880 販売手数料 ¥3,188 配送料 ¥850 販売利益 ¥27,842 購入日時 2026年10月12日 20:53 商品ID m94790189056','m94790189056');assert.equal(value.sold_on,'2026-10-12');assert.equal(value.sold_price,31880);assert.equal(value.payout_amount,27842);});
test('販売日・振込額・商品IDが不明なら推測しない',()=>{for(const text of ['商品ID u123 取扱日 2026/10/11 決済金額6100 受取金額4371','商品ID u123 取引日2026/10/08 決済金額6100','商品ID u456 取引日2026/10/08 決済金額6100 受取金額4371','商品ID u123 商品ID u456 取引日2026/10/08 決済金額6100 受取金額4371'])assert.throws(()=>parseSellerSaleDetail('ヤフオク',text,'u123'));});
test('商品URLのIDを優先し、数字だけの系統照合や曖昧な通番号を使わない',()=>{const rows=[{external_id:'m1',serial:'123a'},{external_id:'m2',serial:'123'},{external_id:'m3',serial:'999'}];assert.deepEqual(sellerTarget(rows,[{external_id:'m1',serial:'123a'},{serial:'123b'}]),[rows[0]]);assert.deepEqual(sellerTarget(rows,[{serial:'123'},{serial:'123'}]),[]);assert.throws(()=>sellerUrl(settings.accounts[0],'https://example.com/item/m1'));assert.throws(()=>sellerUrl(settings.accounts[0],'https://jp.mercari.com/login'));});
test('7アカウントの完了が揃わない間は販売サイトへアクセスしない',async()=>{let access=0;const data={};await sellerDaily({settings,records:records(),day,profileId:'profile',storage:{set:async value=>Object.assign(data,value)},rpc:async name=>{assert.equal(name,'extension_seller_daily_barrier');return false;},openSession:async()=>{access++;},log:async()=>{}});assert.equal(access,0);assert.equal(data.sellerBarrierDay,day);});
test('サイトのエラーで同じアカウントを何度も開かず、失敗も当日の実行済みとする',async()=>{let opened=0;const data={};const firstOnly={...settings,accounts:[settings.accounts[0]]};const deps={settings:firstOnly,records:records(),day,profileId:'profile',storage:{set:async value=>Object.assign(data,value)},rpc:async name=>name==='extension_seller_daily_barrier'?true:[],openSession:async()=>{opened++;throw Error('ログイン切れ');},log:async()=>{}};await sellerDaily(deps);assert.equal(opened,1);assert.equal(data.sellerDailyAttempt.status,'failed');await sellerDaily({...deps,records:{...records(),...data}});assert.equal(opened,1);});
test('送信結果が不明でも同じ操作を再送しない',async()=>{let claimed=false,submitted=0,finished;const job={id:'one',account_id:'mercari-2',kind:'message_send',url:'https://jp.mercari.com/transaction/m1'};const deps={settings,rpc:async(name,args)=>{if(name==='extension_seller_queue')return[job];if(name==='extension_claim_seller_operation'){if(claimed)return false;claimed=true;return true;}if(name==='extension_finish_seller_operation'){finished=args;return;}throw Error(name);},openSession:async()=>({go:async()=>{},operation:async()=>{submitted++;throw Error('response lost');},close:async()=>{}}),log:async()=>{}};await sellerQueuedOperations(deps);await sellerQueuedOperations(deps);assert.equal(submitted,1);assert.equal(finished.p_status,'uncertain');});

test('Chromeの未取得結果nullを状態行として扱わず安全に停止する',async()=>{let tab={id:1,url:'https://jp.mercari.com/mypage/purchases',status:'complete'};const tabs={query:async()=>[tab],get:async()=>tab,update:async(id,value)=>(tab={...tab,...value})};const session=await openSellerSession({id:'mercari-2',site:'mercari',identity:{pageUrl:tab.url}},{tabs,scripting:{executeScript:async()=>[{result:null}]},identity:async()=>({confirmed:true})});await assert.rejects(session.read('取引中'),/販売画面から結果を取得できません/);await session.close();});

test('フレームの応答が止まった場合は時間切れで終了し、自動で再実行しない',async()=>{let tab={id:7,url:'https://jp.mercari.com/mypage/purchases',status:'complete'},calls=0;const tabs={query:async()=>[tab],get:async()=>tab,update:async(id,value)=>(tab={...tab,...value})};const session=await openSellerSession({id:'mercari-2',site:'mercari',identity:{pageUrl:tab.url}},{tabs,scripting:{executeScript:()=>{calls++;return new Promise(()=>{});}},identity:async()=>({confirmed:true}),executionTimeoutMs:20});await assert.rejects(session.read('取引中'),/時間切れ/);await session.close();assert.equal(calls,1);});
test('ヤフオク出品中が空でも出品終了分と売上金管理まで継続する',async()=>{
 const data={},visits=[],calls=[];const account={id:'auctions-1',site:'auctions',label:'ヤフオク1',enabled:true},deps={settings:{...settings,accounts:[account]},records:records(),day,profileId:'profile',storage:{set:async v=>Object.assign(data,v)},rpc:async(name,args)=>{calls.push(name);return name==='extension_seller_daily_barrier'?true:name==='seller_sync_context'?[{account_id:'auctions-1',serial:'2398'}]:null;},log:async()=>{},openSession:async()=>({links:async()=>[{text:'出品中',url:'https://auctions.yahoo.co.jp/my/selling'}],go:async url=>visits.push(url),read:async phase=>({rows:[],empty:true,itemCount:0,navigation:phase==='出品中'?[{text:'出品終了分',url:'https://auctions.yahoo.co.jp/my/closed'}]:phase==='出品終了分'?[{text:'売上金管理',url:'https://salesmanagement.yahoo.co.jp/'}]:[]}),close:async()=>visits.push('restore')})};
 await sellerDaily(deps);assert.deepEqual(visits,['https://auctions.yahoo.co.jp/my/selling','https://auctions.yahoo.co.jp/my/closed','https://salesmanagement.yahoo.co.jp/','restore']);assert.equal(data.sellerDailyAttempt.status,'completed');assert.equal(data.sellerDailyAttempt.errors,0);assert(!calls.includes('sync_seller_observation'));
});

test('登録済みタブの実リンクを正規化し、売上金管理の後置説明を取得漏れにしない',async()=>{let tab={id:8,url:'https://auctions.yahoo.co.jp/my/won',status:'complete'};const tabs={query:async()=>[tab],get:async()=>tab,update:async(id,v)=>(tab={...tab,...v}),create:async()=>{throw Error('新規タブ禁止');}},links=[{text:'売上金管理 Yahoo!かんたん決済',url:'https://salesmanagement.yahoo.co.jp/list'},{text:'受取口座の管理 Yahoo!ウォレット',url:'https://aucpay.yahoo.co.jp/detail-front/BankAccountConfirm'}];const session=await openSellerSession({id:'auctions-1',site:'auctions',identity:{pageUrl:tab.url}},{tabs,scripting:{executeScript:async()=>[{result:{links}}]},identity:async()=>({confirmed:true})});assert.deepEqual(await session.links(),[{text:'売上金管理',url:links[0].url}]);await session.close();});

for(const recover of [true,false])test('出品送信の応答消失は結果だけ確認し再送しない '+recover,async()=>{
 let claimed=false,finished;const phases=[];const job={id:'publish-one',account_id:'mercari-2',channel:'メルカリ',kind:'listing',payload:{photos:[]}};
 const deps={settings,rpc:async(name,args)=>{if(name==='extension_seller_queue')return[job];if(name==='extension_claim_seller_operation'){if(claimed)return false;claimed=true;return true;}if(name==='extension_finish_seller_operation'){finished=args;return;}throw Error(name);},openSession:async()=>({links:async()=>[{text:'出品',url:'https://jp.mercari.com/sell/create'}],go:async()=>{},structure:async()=>({fileInputs:[{}]}),loaded:async()=>{},operation:async(job,phase)=>{phases.push(phase);if(phase==='publish')throw Error('販売画面から結果を取得できません');if(phase==='listing_result'){if(!recover)throw Error('確認不可');return {external_id:'m123',url:'https://jp.mercari.com/item/m123'};}return {};},close:async()=>{}}),log:async()=>{}};
 await sellerQueuedOperations(deps);await sellerQueuedOperations(deps);assert.equal(phases.filter(p=>p==='publish').length,1);assert.equal(phases.filter(p=>p==='listing_result').length,1);assert.equal(finished.p_status,recover?'succeeded':'uncertain');
});
for(const scenario of ['match','duplicate','suffix','account','claim','id-priority'])test('不確定な出品は読み取りだけで照合 '+scenario,async()=>{
 const phases=[],calls=[];let finished;const job={id:'check',kind:'listing',account_id:scenario==='account'?'missing':'mercari-2',inventory_sku:'1856b-EEII-20260927-0',result:scenario==='id-priority'?{read_check_url:'https://jp.mercari.com/item/m1'}:{},read_only_listing_check:true};
 const rows=scenario==='suffix'?[{serial:'1856',external_id:'m1',status:'出品中'}]:[{serial:scenario==='id-priority'?'999':'1856b',external_id:'m1',url:'https://jp.mercari.com/item/m1',status:'出品中'},...(scenario==='duplicate'?[{serial:'1856b',external_id:'m2',status:'出品中'}]:[])];
 await sellerQueuedOperations({settings,rpc:async(name,args)=>{calls.push(name);if(name==='extension_seller_queue')return[job];if(name==='extension_claim_listing_result_check')return scenario!=='claim';if(name==='extension_finish_listing_result_check'){finished=args.p_result;return;}throw Error('Write RPC forbidden: '+name);},openSession:async()=>({links:async()=>[{text:'出品中',url:'https://jp.mercari.com/mypage/listings'}],go:async()=>{},read:async()=>({rows,navigation:[],active:'出品中'}),operation:async(job,phase)=>{phases.push(phase);return {external_id:'m1',verified_serial:'1856b'};},close:async()=>{}}),log:async()=>{}});
 assert(!calls.includes('extension_claim_seller_operation'));assert(!phases.some(p=>p!=='listing_result'));if(['match','id-priority'].includes(scenario))assert.equal(finished.external_id,'m1');else if(['duplicate','suffix'].includes(scenario)){assert(finished.note);assert.equal(phases.length,0);}else assert.equal(finished,undefined);
});

test('結果確認専用RPCを実API経路で送り、任意のRPCは拒否する',async()=>{
 const {rpc}=await import('../tools/fleamarket-extension/api.js');const original=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>true};};
 try{for(const name of ['extension_claim_listing_result_check','extension_finish_listing_result_check'])assert.equal(await rpc(name,{p_id:'fixture'},'test-only-token'),true);await assert.rejects(rpc('delete_everything',{},'test-only-token'),/許可されていない/);assert.equal(requests.length,2);assert(requests.every(r=>r.url.endsWith('listing_result_check')&&r.body.p_id==='fixture'));}finally{globalThis.fetch=original;}
});

test('結果読取自体の応答消失でも再出品せず一度だけ読み直す',async()=>{
 let reads=0,publishes=0,finished;const job={id:'read-lost',account_id:'mercari-2',channel:'メルカリ',kind:'listing',payload:{photos:[]}};
 await sellerQueuedOperations({settings,rpc:async(name,args)=>{if(name==='extension_seller_queue')return[job];if(name==='extension_claim_seller_operation')return true;if(name==='extension_finish_seller_operation'){finished=args;return;}throw Error(name);},openSession:async()=>({links:async()=>[{text:'出品',url:'https://jp.mercari.com/sell/create'}],go:async()=>{},structure:async()=>({fileInputs:[{}]}),loaded:async()=>{},operation:async(job,phase)=>{if(phase==='publish'){publishes++;return {submitted:true};}if(phase==='listing_result'){if(++reads===1)throw Error('response lost');return {external_id:'m123',url:'https://jp.mercari.com/item/m123'};}return {};},close:async()=>{}}),log:async()=>{}});
 assert.equal(publishes,1);assert.equal(reads,2);assert.equal(finished.p_status,'succeeded');
});

import {sellerHourlyReady} from '../tools/fleamarket-extension/seller-sync.js';
test('毎時確認は前回開始から60分、日付変更や再起動で連続実行せず日次処理は維持',()=>{
 const now=Date.parse('2026-10-19T15:05:00Z');
 assert(sellerHourlyReady(settings,{},now));
 for(const status of ['running','completed','failed']){
  const r={sellerHourlyAttempt:{status,startedAt:new Date(now-3599999).toISOString()}};
  assert.equal(sellerHourlyReady(settings,r,now),false);
  assert.equal(sellerHourlyReady(settings,r,now+1),true);
 }
 assert.equal(sellerHourlyReady(settings,{sellerDailyAttempt:{at:new Date(now).toISOString()}},now),false);
 for(const r of [{job:{}},{authProblem:true}])assert.equal(sellerHourlyReady(settings,r,now),false);
 assert.equal(sellerHourlyReady({...settings,mode:'diagnostic'},{},now),false);
 assert.equal(sellerHourlyReady({...settings,accounts:[]},{},now),false);
});
for(const source of ['tools','apps'])test(source+' 毎時は販売状態だけ、過去売上/完了判定/日次バリア/サイト書込みなし',async()=>{
 const {sellerDaily:run}=await import('../'+source+'/fleamarket-extension/seller-runtime.js');
 const state={},visits=[],calls=[],detail=[],applied=[];const now=Date.parse('2026-10-19T15:05:00Z');
 const account={id:'mercari-2',site:'mercari',label:'メルカリ2',enabled:true};
 const menu=[{text:'出品中',url:'https://jp.mercari.com/mypage/listings/listing'}, {text:'取引中',url:'https://jp.mercari.com/mypage/listings/in_progress'}, {text:'売却済み',url:'https://jp.mercari.com/mypage/listings/completed'}];
 const row={external_id:'m123456789',serial:'2398',status:'取引中',detail_url:'https://jp.mercari.com/transaction/m123456789'};
 const deps={settings:{...settings,accounts:[account]},records:{},day:'2026-10-20',profileId:'profile',hourly:true,now,storage:{set:async v=>Object.assign(state,v)},log:async()=>{},rpc:async(name,args)=>{
  calls.push(name);
  if(name==='seller_observation_plan')return args.p_rows.map(r=>({external_id:r.external_id,action:'detail'}));
  if(name==='sync_seller_observation'){applied.push(args.p_observation);return 'updated';}
  throw Error('Unexpected RPC '+name);
 },openSession:async()=>({links:async()=>menu,go:async url=>visits.push(url),read:async phase=>({empty:phase==='出品中',itemCount:2,rows:phase==='取引中'?[row,{external_id:'m999',status:'販売済'}]:[],navigation:menu}),detail:async url=>{detail.push(url);return {url,text:'購入日時 2026年10月20日 00:04'};},operation:()=>{throw Error('Site write prohibited');},close:async()=>{visits.push('restored');}})};
 await run(deps);
 assert.equal(state.sellerHourlyAttempt.status,'completed');assert.equal(state.sellerHourlyAttempt.updated,1);
 assert.equal(state.sellerDailyAttempt,undefined);assert.equal(state.sellerSaleBackfills,undefined);
 assert.deepEqual(visits,[menu[0].url,menu[1].url,'restored']);assert.deepEqual(detail,[row.detail_url]);
 assert.deepEqual(calls,['seller_observation_plan','sync_seller_observation']);assert.equal(applied[0].status,'取引中');
 assert(!('sold_on' in applied[0]));assert(state.sellerHourlyAttempt.responseBytes>0);
 await run({...deps,records:state,now:now+59999});assert.equal(applied.length,1);
 await run({...deps,records:state,now:now+3600000});assert.equal(applied.length,1);assert.equal(state.sellerHourlyAttempt.cacheHits,1);assert.equal(state.sellerHourlyAttempt.rpcCalls,0);row.status='キャンセル';await run({...deps,records:state,now:now+7200000});assert.equal(applied.length,2);
});
test('毎時確認失敗も60分は再実行せず、キュー操作を呼ばない',async()=>{
 const data={},now=Date.parse('2026-10-20T01:00:00Z');let access=0;
 const deps={settings,records:{},day:'2026-10-20',hourly:true,now,storage:{set:async v=>Object.assign(data,v)},rpc:async()=>{throw Error('unexpected RPC');},openSession:async()=>{access++;throw Error('ログイン・追加認証が必要');},log:async()=>{}};
 await sellerDaily(deps);assert.equal(data.sellerHourlyAttempt.status,'failed');assert.equal(access,3);
 await sellerDaily({...deps,records:data,now:now+60000});assert.equal(access,3);
});

test('ヤフオク毎時は出品終了分もページ送りし、変化のない取引中は個別画面/更新を省略',async()=>{
 const state={},visits=[],planned=[],account={id:'auctions-1',site:'auctions',label:'ヤフオク1',enabled:true};
 const menu=[{text:'出品中',url:'https://auctions.yahoo.co.jp/my/selling'},{text:'出品終了分',url:'https://auctions.yahoo.co.jp/my/closed'},{text:'売上金管理',url:'https://salesmanagement.yahoo.co.jp/list'}];
 let url;
 await sellerDaily({settings:{...settings,accounts:[account]},records:{},day:'2026-10-20',hourly:true,storage:{set:async v=>Object.assign(state,v)},log:async()=>{},rpc:async(name,args)=>{
  assert.equal(name,'seller_observation_plan');planned.push(...args.p_rows);return args.p_rows.map(r=>({external_id:r.external_id,action:'unchanged'}));
 },openSession:async()=>({links:async()=>menu,go:async u=>{url=u;visits.push(u);},read:async phase=>({empty:phase==='出品中',itemCount:1,rows:phase==='出品終了分'?[{external_id:url.endsWith('page=2')?'m2':'m1',status:'取引中'}]:[],navigation:url===menu[1].url?[{text:'次へ',url:menu[1].url+'?page=2'}]:[]}),detail:async()=>{throw Error('Unchanged trade detail must not open');},close:async()=>{}})});
 assert.deepEqual(visits,[menu[0].url,menu[1].url,menu[1].url+'?page=2']);assert.equal(planned.length,2);
 assert.equal(state.sellerHourlyAttempt.status,'completed');assert.equal(state.sellerHourlyAttempt.updated,0);
});

import {sellerCachedObservation,sellerObservationFingerprint} from '../tools/fleamarket-extension/seller-sync.js';
test('確認済み商品のキャッシュはアカウント別で24時間以内だけ、状態/注意/通番号/取引キー変更を見逃さない',()=>{
 const now=Date.parse('2026-10-20T03:00:00Z'),row={external_id:'m123',serial:'2398',status:'取引中',trade_key:'m123',attention:false};
 const cache={m123:{checkedAt:now,fingerprint:sellerObservationFingerprint(row)}};
 assert(sellerCachedObservation(cache,row,now+23*3600000));assert(!sellerCachedObservation(cache,row,now+24*3600000));assert(!sellerCachedObservation(cache,row,now-1));
 for(const changed of [{status:'キャンセル'},{attention:true},{serial:'2398b'},{trade_key:'m123:new'},{external_id:'m456'}])assert(!sellerCachedObservation(cache,{...row,...changed},now));
 assert(!sellerCachedObservation({},row,now));
});
test('未一致・保護中の商品をキャッシュせず、アプリ登録や保留解除後も再照合する',async()=>{
 const data={},now=Date.parse('2026-10-20T03:00:00Z'),account=settings.accounts[0];let calls=0;
 const deps={settings:{...settings,accounts:[account]},records:{},day:'2026-10-20',hourly:true,now,storage:{set:async v=>Object.assign(data,v)},log:async()=>{},rpc:async(name,args)=>{assert.equal(name,'seller_observation_plan');calls++;return args.p_rows.map(r=>({external_id:r.external_id,action:r.external_id==='m1'?'unmatched':'protected'}));},openSession:async()=>({links:async()=>[{text:'取引中',url:'https://jp.mercari.com/mypage/listings/in_progress'}],go:async()=>{},read:async()=>({rows:[{external_id:'m1',status:'取引中'},{external_id:'m2',status:'取引中'}],navigation:[],itemCount:2}),close:async()=>{}})};
 await sellerDaily(deps);await sellerDaily({...deps,records:data,now:now+3600000});assert.equal(calls,2);assert.deepEqual(data.sellerObservationCache.accounts[account.id],{});
});
