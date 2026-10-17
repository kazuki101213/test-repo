import test from 'node:test';import assert from 'node:assert/strict';
import {sellerDaily} from '../../tools/fleamarket-extension/seller-runtime.js';
import {sellerAccounts} from '../../tools/fleamarket-extension/seller-sync.js';
const day='2026-10-17',account={id:'mercari-1',site:'mercari',label:'メルカリ1',enabled:true};
const row=(n,status='販売済')=>({external_id:'m'+n,serial:String(n),status,trade_key:'m'+n,detail_url:'https://jp.mercari.com/transaction/m'+n});
async function run({rows=[row(1)],actions={},full=false,site='mercari',pages=null,detailError=false,more=null}={}){
 const data={},visits=[],details=[],writes=[],plans=[];let pageNo=0;
 const acc={...account,...(site==='auctions'?{id:'auctions-2',site:'auctions'}:{})},phase=site==='mercari'?'売却済み':'売上金管理';
 const base=site==='mercari'?'https://jp.mercari.com/mypage/listings/completed':'https://salesmanagement.yahoo.co.jp/list';
 const list=pages||[rows];
 const records={scheduledRuns:{tracking:{day},purchases:{day}},lastRun:{tracking:{day},purchases:{day}},sellerSaleBackfills:full?{}:{[acc.id]:true}};
 const deps={settings:{mode:'tracking',purchaseImportEnabled:true,accounts:[acc]},records,day,profileId:'fixture',storage:{set:async v=>Object.assign(data,v)},log:async()=>{},
 rpc:async(name,args)=>{if(name==='extension_seller_daily_barrier')return true;if(name==='seller_observation_plan'){plans.push(args.p_rows);return args.p_rows.map(r=>({external_id:r.external_id,action:actions[r.external_id]||'registered'}));}if(name==='sync_seller_observation'){writes.push(args);return 'registered';}throw Error('Unexpected RPC '+name);},
 openSession:async()=>({links:async()=>[{text:phase,url:base}],go:async u=>{visits.push(u);pageNo=Number(new URL(u).searchParams.get('page')||0);},
 read:async()=>({rows:list[pageNo],itemCount:list[pageNo].length,empty:!list[pageNo].length,navigation:pageNo+1<list.length?[{text:'次へ',url:base+'?page='+(pageNo+1)}]:[]}),
 advanceList:more?async()=>{pageNo++;return more(pageNo);}:undefined,
 detail:async(url,id)=>{details.push(id);if(detailError)throw Error('network');return {url:site==='mercari'?url:'https://aucpay.yahoo.co.jp/detail/'+id,text:site==='mercari'?'商品ID '+id+' 商品代金 1000 販売利益 800 購入日時 2026/10/16 12:00':'商品ID '+id+' 決済金額 1000 受取金額 800 取引日 2026/10/16 12:00'};},close:async()=>visits.push('restore')})};
 await sellerDaily(deps);return {data,visits,details,writes,plans,deps};
}
test('販売確認は4アカウント、無関係なフリマは除外する',()=>assert.deepEqual(sellerAccounts({accounts:['mercari-1','mercari-2','auctions-1','auctions-2','flea-1'].map(id=>({id,enabled:true}))}).map(x=>x.id),['mercari-1','mercari-2','auctions-1','auctions-2']));
test('メルカリ初回は登録済み5件を超えて最後まで照合し、成功後だけ初回完了を保存する',async()=>{const r=await run({full:true,pages:[[1,2,3,4,5,6].map(n=>row(n)),[row(7)]],actions:{m7:'detail'}});assert.equal(r.visits.filter(x=>x!=='restore').length,2);assert.deepEqual(r.details,['m7']);assert.equal(r.data.sellerSaleBackfills['mercari-1'],true);assert.equal(r.data.sellerDailyAttempt.errors,0);});
test('2回目のメルカリは登録済み5件連続で終了し、次ページも詳細も開かない',async()=>{const r=await run({pages:[[1,2,3,4,5,6].map(n=>row(n)),[row(7)]],actions:{m6:'detail'}});assert.equal(r.visits.filter(x=>x!=='restore').length,1);assert.deepEqual(r.details,[]);assert.equal(r.writes.length,0);});
test('未一致は連続件数を0に戻し、再び5件揃うまで進む',async()=>{const r=await run({pages:[[1,2,3,4,5].map(n=>row(n)),[6,7,8,9,10,11].map(n=>row(n))],actions:{m3:'unmatched',m9:'detail'}});assert.equal(r.visits.filter(x=>x!=='restore').length,2);assert.deepEqual(r.details,[]);assert.equal(r.data.sellerDailyAttempt.unmatched,1);});
test('新規登録後はその商品を既存登録済みに数えず、確認済み5件の後で止める',async()=>{const r=await run({rows:[1,2,3,4,5,6,7,8].map(n=>row(n)),actions:{m2:'detail',m8:'detail'}});assert.deepEqual(r.details,['m2']);assert.equal(r.writes[0].p_account_id,'mercari-1');assert.equal(r.writes[0].p_observation.sold_on,'2026-10-16');});
test('ヤフオク2は登録済みが何件続いても全ページを確認し、新規のみ詳細を開く',async()=>{const r=await run({site:'auctions',pages:[[1,2,3,4,5,6].map(n=>({...row(n),external_id:'u'+n})),[{...row(7),external_id:'u7'}]],actions:{u7:'detail'}});assert.equal(r.visits.filter(x=>x!=='restore').length,2);assert.deepEqual(r.details,['u7']);assert.equal(r.writes[0].p_account_id,'auctions-2');});
test('詳細取得エラーはそのアカウントを停止し初回完了にせず、同日に再巡回しない',async()=>{const r=await run({full:true,actions:{m1:'detail'},detailError:true});assert.equal(r.details.length,1);assert.equal(r.data.sellerDailyAttempt.status,'failed');assert.equal(r.data.sellerSaleBackfills,undefined);await sellerDaily({...r.deps,records:{...r.deps.records,...r.data}});assert.equal(r.details.length,1);});
test('取得上限や照合結果不明を登録済み扱いしない',async()=>{const r=await run({full:true,actions:{m1:'protected'}});assert.equal(r.writes.length,0);assert.equal(r.details.length,0);});
