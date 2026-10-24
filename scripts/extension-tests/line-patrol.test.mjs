import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const source=readFileSync(new URL('../../tools/fleamarket-extension/background.js',import.meta.url),'utf8');
const start=source.indexOf('async function runSellerWork('),end=source.indexOf('// A requested time',start);
function fixture({patrol=true,daily=false,busy=false,job=null,manualUpdate=false}={}){
 const calls=[],alarms=[],records={session:{access_token:'fixture'},diagnosticInstance:'fixture-profile',job};
 const context={sellerBusy:false,busy,Date,fetch:async()=>{throw Error('Unexpected network');},chrome:{alarms:{create:async(name,value)=>alarms.push({name,...value}),clear:async(name)=>alarms.push({clear:name})}},launchPending:async()=>false,STORE:{get:async()=>records},PRODUCTION_PLAN:{profiles:{'fixture-profile':[]}},getSettings:async()=>({mode:'tracking'}),receiptAccounts:()=>[],jstDay:()=>'2026-10-24',scheduleDue:()=>false,rpc:async()=>{},log:async()=>{},prepareAccount:x=>x,openSellerSession:async()=>{},content:async()=>{},checkRequestedPackageUpdate:async()=>manualUpdate,runSellerReadOnlyInspection:async()=>false,runSellerSaleRepair:async()=>false,runSellerFeedbackRepair:async()=>false,runOperationQueue:async()=>{},supplierQueuedOperations:async()=>{},sellerQueuedOperations:async()=>{},sellerDaily:async args=>{calls.push(args.hourly?'patrol':'daily');return {ran:args.hourly||daily};},processLineShipping:async()=>calls.push('LINE')};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);return{calls,alarms,run:()=>context.runSellerWork({patrol})};
}
test('4時間アラームと1時の巡回が重なっても一覧を二重巡回しない',async()=>{const f=fixture({daily:true});await f.run();assert.deepEqual(f.calls,['daily','LINE']);assert(f.alarms.some(a=>a.clear==='fm:seller-patrol-retry'));});
test('4時間アラームは専用巡回後だけLINE準備し、毎分処理からは起動しない',async()=>{const a=fixture();await a.run();assert.deepEqual(a.calls,['daily','patrol','LINE']);const b=fixture({patrol:false});await b.run();assert.deepEqual(b.calls,['daily']);});
test('他の処理が実行中ならサイトにアクセスせず一時的な再開アラームだけを予約する',async()=>{for(const opts of[{busy:true},{job:{kind:'tracking'}}]){const f=fixture(opts);await f.run();assert.deepEqual(f.calls,[]);assert.equal(f.alarms[0].name,'fm:seller-patrol-retry');assert(f.alarms[0].when>Date.now());}});

test('明示更新を読み込んだ回は販売巡回やLINE準備を重ねて起動しない',async()=>{const f=fixture({manualUpdate:true});await f.run();assert.deepEqual(f.calls,[]);});
