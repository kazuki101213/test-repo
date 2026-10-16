import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsDefault} from '../../tools/fleamarket-extension/core.js';
const data={};let listener,alarmHandler;const requests=[];let pageKind='list',submitClicks=0,adminTabs=[],sessionCreations=0;
globalThis.chrome={
 storage:{local:{get:async keys=>{if(typeof keys==='string')return {[keys]:structuredClone(data[keys])};return Object.fromEntries(keys.map(k=>[k,structuredClone(data[k])]));},set:async obj=>{Object.assign(data,structuredClone(obj));},remove:async key=>{delete data[key];},setAccessLevel:async()=>{}}},
 runtime:{id:'unit',getManifest:()=>({version:'0.1.2'}),getURL:path=>'chrome-extension://unit/'+path,onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}}},
 alarms:{get:async()=>null,create:async()=>{},onAlarm:{addListener:fn=>alarmHandler=fn}},action:{setBadgeText:async()=>{}},
 tabs:{query:async()=>adminTabs,create:async({url})=>({id:1,url}),update:async(id,{url})=>{pageKind=url.includes('transaction')?'detail':'list';},get:async()=>({id:1,status:'complete',url:'https://jp.mercari.com/transaction/m123456789'}),remove:async()=>{},sendMessage:async(id,m)=>{
   if(m.type==='fm:list')return {ok:true,value:{links:['https://jp.mercari.com/transaction/m123456789'],nextUrl:null}};
   if(m.type==='fm:detail')return {ok:true,value:{itemId:'m123456789',role:'buyer',state:'pending',trackingNo:'123456789012'}};
   if(m.type==='fm:submit'){submitClicks++;return {ok:true,value:{clicked:true}};}
   if(m.type==='fm:success')return {ok:true,value:{success:true}};
   return {ok:true,value:{ok:true}};
 }},scripting:{executeScript:async({args})=>{if(args){sessionCreations++;return [{result:{access_token:'independent-token',refresh_token:'independent-refresh'}}];}return [{result:{access_token:'existing-admin-token',email:'admin@example.test'}}];}}
};
globalThis.fetch=async(url,options)=>{
  const name=url.split('/').at(-1),args=JSON.parse(options.body||'{}');requests.push({name,args});
  let result;
  if(name==='is_admin'||name==='marketplace_purchase_lease')result=true;
  else if(name==='marketplace_extension_runtime_report')result={reported:true};
  else if(name==='marketplace_tracking_candidates')result={day:'2026-10-05',cutoff:'2026-09-05',items:[]};
  else if(name==='marketplace_extension_probe')result={count:1,items:[{sku:'123-TEST-20261004-1',inspected_at:'2026-10-04',cleaned_at:'2026-10-04'}]};
  else if(name==='reconcile_marketplace_tracking')result={result:'updated'};
  else if(name==='marketplace_extension_receipt')result=args.p_action==='reserve'?{eligible:true,token:'00000000-0000-0000-0000-000000000001'}:{ok:true};
  else throw new Error('Unexpected network request '+url);
  return {ok:true,json:async()=>result};
};
await import('../../tools/fleamarket-extension/background.js');
await new Promise(r=>setTimeout(r,20));
function ui(type,extra={}){return new Promise(resolve=>listener({type,...extra},{id:'unit',url:'chrome-extension://unit/popup.html'},resolve));}
async function pulse(){alarmHandler({name:'fm:pulse'});await new Promise(r=>setTimeout(r,1600));}
function reset(mode='diagnostic'){
  requests.length=0;submitClicks=0;data.events=[];data.job=null;data.outbox=[];data.lastRun={};data.session={access_token:'mock',refresh_token:'mock',expires_at:Date.now()/1000+3600};
  data.settings=settingsDefault();data.settings.openNewTabs=true;data.settings.mode=mode;const a=data.settings.accounts[0];a.enabled=true;a.listUrl='https://jp.mercari.com/mypage/purchases';a.identity={selector:'#me',text:'購入者A'};
  data.settings.recipes.mercari={scope:'main',verified:mode!=='diagnostic',receiptVerified:mode==='full',receiptScope:'#rating',positive:'#good',submit:'#submit',submitText:'受取評価をする',successText:'完了'};
  data.settings.migrationConfirmed=true;
}
test('サイトのcontent scriptから管理操作・セッション読み取りを要求できない',()=>{
  let replied=false;const result=listener({type:'state'},{id:'unit',url:'https://jp.mercari.com/',tab:{id:1}},()=>replied=true);assert.equal(result,false);assert.equal(replied,false);
});
test('状態と診断のエクスポートに認証トークンを含めない',async()=>{
  reset();const state=await ui('state');assert.equal(state.value.connected,true);assert.equal(state.value.session,undefined);assert.equal((await ui('export')).value.session,undefined);
});
test('初回連携は管理者を確認し、元アプリと独立したセッションを保存する',async()=>{
  reset();adminTabs=[{id:99,url:'https://bussan-admin.vercel.app/'}];sessionCreations=0;const result=await ui('connect');assert.equal(result.ok,true);assert.equal(sessionCreations,1);assert.equal(data.session.access_token,'independent-token');assert.equal(data.session.refresh_token,'independent-refresh');assert.equal(requests.filter(x=>x.name==='is_admin').length,2);adminTabs=[];
});
test('診断モードでは照合だけ行い、追跡番号登録・評価送信を行わない',async()=>{
  reset();assert.equal((await ui('start',{kind:'tracking'})).ok,true);await new Promise(r=>setTimeout(r,1200));await pulse();assert.equal(requests.some(x=>x.name==='marketplace_extension_probe'),true);assert.equal(requests.some(x=>x.name==='reconcile_marketplace_tracking'),false);assert.equal(submitClicks,0);await ui('stop');
});
test('追跡番号モードでは指定RPCだけで登録する',async()=>{
  reset('tracking');await ui('start',{kind:'tracking'});await new Promise(r=>setTimeout(r,1200));await pulse();const writes=requests.filter(x=>x.name==='reconcile_marketplace_tracking');assert.equal(writes.length,1);assert.equal(writes[0].args.p_marketplace_item_id,'m123456789');assert.equal(data.job.counts.updated,1);assert.equal(submitClicks,0);await ui('stop');
});
test('送信途中の再起動では評価を再送せず、確認タスクに記録する',async()=>{
  reset('full');const a=data.settings.accounts[0];data.job={kind:'receipt',settings:data.settings,accounts:[a],accountIndex:0,stage:'sending',index:0,counts:{errors:0},pendingReceipt:{itemId:'m123456789',token:'00000000-0000-0000-0000-000000000001'}};
  await pulse();assert.equal(submitClicks,0);assert.equal(requests.find(x=>x.name==='marketplace_extension_receipt').args.p_action,'unknown');assert.equal(requests.find(x=>x.name==='reconcile_marketplace_tracking').args.p_confirmation_status,'評価結果要確認');assert.equal(data.job.index,1);data.job=null;
});
test('未検証の設定は本番モードにできない',async()=>{
  reset();const s=structuredClone(data.settings);s.mode='tracking';assert.equal((await ui('save',{settings:s})).ok,false);
});

test('ラクマの登録は毎回マイページで確認し、不一致時は購入履歴を読まない',async()=>{
 reset();data.settings.accounts[0].enabled=false;
 const a=data.settings.accounts.find(a=>a.id==='rakuma-1');
 a.identity={selector:'#me',text:'Greenさんのマイページ',pageUrl:'https://fril.jp/mypage'};
 const original={query:chrome.tabs.query,create:chrome.tabs.create,get:chrome.tabs.get,sendMessage:chrome.tabs.sendMessage,remove:chrome.tabs.remove};
 let matches=true,checks=0,lists=0,closed=0;
 try{
 chrome.tabs.query=async()=>[{id:50,url:'https://fril.jp/buy'}];
 chrome.tabs.create=async()=>({id:51,url:'https://fril.jp/mypage'});
 chrome.tabs.get=async id=>({id,status:'complete',url:id===51?'https://fril.jp/mypage':'https://fril.jp/buy'});
 chrome.tabs.remove=async()=>{closed++;};
 chrome.tabs.sendMessage=async(id,m)=>{
   if(m.type==='fm:identity'){checks++;assert.equal(id,51);assert.equal(m.account._identityConfirmed,false);return matches?{ok:true,value:{confirmed:true}}:{ok:false,error:'アカウントが一致しません'};}
   if(m.type==='fm:list'){lists++;assert.equal(m.account._identityConfirmed,true);return {ok:true,value:{links:[]}};}
   throw Error('unexpected message');
 };
 assert.equal((await ui('bind',{id:a.id})).ok,true);assert.equal(checks,1);assert.equal(lists,1);assert.equal(closed,1);
 assert.equal(data.settings.accounts.find(x=>x.id===a.id)._identityConfirmed,undefined);
 matches=false;const fail=await ui('bind',{id:a.id});assert.equal(fail.ok,false);assert.equal(checks,2);assert.equal(lists,1);assert.equal(closed,2);
 }finally{Object.assign(chrome.tabs,original);}
});

test('確認済みフラグや別URLを設定保存してアカウント確認を省略できない',async()=>{
 reset();const s=structuredClone(data.settings);s.accounts[0]._identityConfirmed=true;
 assert.equal((await ui('save',{settings:s})).ok,false);
 delete s.accounts[0]._identityConfirmed;s.accounts[6].identity={selector:'#me',text:'Greenさんのマイページ',pageUrl:'https://evil.test/mypage'};
 assert.equal((await ui('save',{settings:s})).ok,false);
});

test('ラクマ自動登録は名前と購入一覧を確認した時だけ保存し、認証切れでは何も登録しない',async()=>{
 reset();data.settings.accounts[0].enabled=false;
 const original={query:chrome.tabs.query,create:chrome.tabs.create,get:chrome.tabs.get,sendMessage:chrome.tabs.sendMessage,remove:chrome.tabs.remove};
 let nextId=100,closed=0,fail=false;const urls=new Map();
 try{
 chrome.tabs.query=async()=>[{id:50,url:'https://fril.jp/mypage'}];
 chrome.tabs.create=async({url})=>{const id=nextId++;urls.set(id,url);return {id,url};};
 chrome.tabs.get=async id=>({id,status:'complete',url:urls.get(id)||'https://fril.jp/mypage'});
 chrome.tabs.remove=async()=>{closed++;};
 chrome.tabs.sendMessage=async(id,m)=>{
  if(m.type==='fm:rakumaIdentity')return {ok:true,value:{identity:{selector:'h2',text:'Greenさんのマイページ',pageUrl:'https://fril.jp/mypage'}}};
  if(m.type==='fm:identity')return {ok:true,value:{confirmed:true}};
  if(m.type==='fm:list')return {ok:true,value:fail?{auth:'ログイン切れ'}:{links:[]}};
  throw Error('unexpected message');
 };
 const success=await ui('registerRakuma');assert.equal(success.ok,true);assert.equal(success.value.name,'Greenさんのマイページ');
 const a=data.settings.accounts.find(x=>x.id==='rakuma-1');assert.equal(a.enabled,true);assert.equal(a.listUrl,'https://fril.jp/buy');assert.equal(a.identity.pageUrl,'https://fril.jp/mypage');assert.equal(closed,3);
 data.settings.accounts[6]={id:'rakuma-1',site:'rakuma',label:'ラクマ1',enabled:false};fail=true;
 assert.equal((await ui('registerRakuma')).ok,false);assert.equal(data.settings.accounts[6].identity,undefined);assert.equal(data.settings.accounts[6].enabled,false);assert.equal(closed,6);
 assert.equal(requests.length,0);assert.equal(submitClicks,0);
 }finally{Object.assign(chrome.tabs,original);}
});

test('登録削除は選択アカウントの名前と一覧だけを消し、他アカウントと連携を維持する',async()=>{
 reset();const session=structuredClone(data.session),other=structuredClone(data.settings.accounts[6]);
 const result=await ui('clearAccount',{id:'mercari-1'});assert.equal(result.ok,true);
 const a=data.settings.accounts[0];assert.equal(a.enabled,false);assert.equal(a.identity,undefined);assert.equal(a.listUrl,undefined);
 assert.deepEqual(data.settings.accounts[6],other);assert.deepEqual(data.session,session);assert.equal(requests.length,0);assert.equal(submitClicks,0);
 assert.equal((await ui('clearAccount',{id:'invalid'})).ok,false);
});

test('巡回中は登録を削除せず名前と対象一覧を維持する',async()=>{
 reset();const before=structuredClone(data.settings);data.job={kind:'tracking'};
 assert.equal((await ui('clearAccount',{id:'mercari-1'})).ok,false);assert.deepEqual(data.settings,before);data.job=null;
});

test('共通ボタンは選択サイトのアカウントだけを登録し、別サイト指定や読み取り失敗は保存しない',async()=>{
 const original={query:chrome.tabs.query,create:chrome.tabs.create,get:chrome.tabs.get,sendMessage:chrome.tabs.sendMessage,remove:chrome.tabs.remove};
 try{for(const [site,id,url] of [['mercari','mercari-2','https://jp.mercari.com/mypage/purchases'],['flea','flea-2','https://paypayfleamarket.yahoo.co.jp/my/purchases']]){
  reset();data.settings.accounts[0].enabled=false;let fail=false,listReads=0;
  chrome.tabs.query=async()=>[{id:50,url}];chrome.tabs.create=async()=>({id:51,url});chrome.tabs.get=async id=>({id,status:'complete',url});chrome.tabs.remove=async()=>{};
  chrome.tabs.sendMessage=async(tab,m)=>{
   if(m.type==='fm:autoIdentity')return {ok:true,value:{identity:{selector:'header a',text:'siro',pageUrl:url}}};
   if(m.type==='fm:identity')return {ok:true,value:{confirmed:true}};
   if(m.type==='fm:list'){listReads++;return fail?{ok:false,error:'一覧を確認できません'}:{ok:true,value:{links:[]}};}
   throw Error('unexpected message');
  };
  assert.equal((await ui('registerSite',{id:'rakuma-1'})).ok,false);assert.equal(listReads,0);
  const result=await ui('registerSite',{id});assert.equal(result.ok,true);const a=data.settings.accounts.find(x=>x.id===id);assert.equal(a.enabled,true);assert.equal(a.identity.text,'siro');assert.equal(a.listUrl,url);assert.equal(data.settings.accounts.filter(x=>x.enabled).length,1);assert.equal(requests.length,0);assert.equal(submitClicks,0);
  const before=structuredClone(data.settings);fail=true;assert.equal((await ui('registerSite',{id})).ok,false);assert.deepEqual(data.settings,before);
 }}finally{Object.assign(chrome.tabs,original);}
});

test('診断の開始に失敗しても原因を保存し、自動レポートを開く',async()=>{
 reset();data.settings.accounts.forEach(a=>a.enabled=false);
 const original=chrome.tabs.create;const urls=[];chrome.tabs.create=async({url})=>{urls.push(url);return {id:91,url};};
 try{assert.equal((await ui('start',{kind:'tracking'})).ok,false);assert.equal(data.events[0].kind,'error');assert.deepEqual(urls,['chrome-extension://unit/report.html']);assert.equal(requests.length,0);}
 finally{chrome.tabs.create=original;}
});

test('ヤフオクの詳細読み取りは落札分の本人確認後だけ実行し、不一致時は止める',async()=>{
 const original={create:chrome.tabs.create,update:chrome.tabs.update,get:chrome.tabs.get,sendMessage:chrome.tabs.sendMessage,remove:chrome.tabs.remove};
 let matches=true,reads=0,checks=0,next=100;const urls=new Map();
 try{chrome.tabs.create=async({url})=>{const id=next++;urls.set(id,url);return {id,url};};chrome.tabs.get=async id=>({id,status:'complete',url:urls.get(id)});chrome.tabs.update=async(id,{url})=>{urls.set(id,url);};chrome.tabs.remove=async()=>{};
 chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='fm:diagnostic')return {ok:true,value:{url:urls.get(id)}};if(m.type==='fm:identity'){checks++;assert.equal(urls.get(id),'https://auctions.yahoo.co.jp/my/won');return matches?{ok:true,value:{confirmed:true}}:{ok:false,error:'アカウントが一致しません'};}if(m.type==='fm:list'){assert.equal(m.account._identityConfirmed,true);return {ok:true,value:{links:['https://contact.auctions.yahoo.co.jp/buyer/top?aid=m123']}};}if(m.type==='fm:detail'){reads++;assert.equal(m.account._identityConfirmed,true);return {ok:true,value:{role:'unknown',state:'unknown',itemId:'m123'}};}throw Error('unexpected');};
 for(const match of [true,false]){reset();matches=match;data.settings.accounts[0].enabled=false;const a=data.settings.accounts[2];a.enabled=true;a.listUrl='https://auctions.yahoo.co.jp/my/won';a.identity={selector:'old selector',text:'Green'};assert.equal((await ui('start',{kind:'tracking'})).ok,true);await new Promise(r=>setTimeout(r,2000));if(match){await pulse();await new Promise(r=>setTimeout(r,800));assert.equal(reads,1);}else{assert.equal(reads,1);assert.equal(data.job,null);}assert.equal(a.identity.pageUrl,undefined);await ui('stop');}
 assert.equal(checks,3);assert.equal(submitClicks,0);
 }finally{Object.assign(chrome.tabs,original);data.job=null;}
});

test('更新後の診断モードも既存タブがなければ止まり、新規タブ・追跡登録・評価を行わない',async()=>{
 reset();data.lastDiagnosticVersion='old';await import('../../tools/fleamarket-extension/background.js?initialization-regression');await new Promise(r=>setTimeout(r,1800));assert.equal(data.lastDiagnosticVersion,'0.1.2');assert.equal(data.events.filter(e=>e.text==='追跡番号の巡回を開始').length,1);assert.equal(data.job,null);assert.equal(data.settings.openNewTabs,false);assert.ok(data.events.some(e=>e.text.includes('既存タブがありません')));assert.equal(requests.some(x=>x.name==='reconcile_marketplace_tracking'),false);assert.equal(submitClicks,0);await ui('stop');
});

test('メルカリ読み取り時だけタブを表示し、利用者がタブを変えた場合は元へ強制移動しない',async()=>{
 const original={query:chrome.tabs.query,create:chrome.tabs.create,update:chrome.tabs.update,get:chrome.tabs.get,sendMessage:chrome.tabs.sendMessage,remove:chrome.tabs.remove};
 try{for(const switched of [false,true]){reset();let active=9,next=100;const urls=new Map(),updates=[],created=[];chrome.tabs.query=async()=>[{id:active}];chrome.tabs.create=async({url,active:show})=>{const id=next++;urls.set(id,url);created.push({id,show,url});if(show)active=id;return {id,url};};chrome.tabs.get=async id=>({id,status:'complete',url:urls.get(id)});chrome.tabs.update=async(id,args)=>{updates.push({id,...args});if(args.active)active=id;if(args.url)urls.set(id,args.url);};chrome.tabs.remove=async()=>{};chrome.tabs.sendMessage=async(id,m)=>{if(m.type==='fm:diagnostic')return {ok:true,value:{}};if(m.type==='fm:list'){if(switched)active=10;return {ok:true,value:{links:[]}};}throw Error('unexpected');};
 assert.equal((await ui('start',{kind:'tracking'})).ok,true);await new Promise(r=>setTimeout(r,1200));assert.equal(created.find(x=>x.url.includes('mercari')).show,true);assert.equal(active,switched?10:9);assert.equal(updates.some(x=>x.id===9&&x.active),!switched);await ui('stop');}
 }finally{Object.assign(chrome.tabs,original);data.job=null;}
});

test('完了済み取引は役割が不明でも照合・確認タスク・評価を実行しない',async()=>{
 reset('tracking');const original=chrome.tabs.sendMessage;
 try{chrome.tabs.sendMessage=async(id,m)=>m.type==='fm:detail'?{ok:true,value:{itemId:'m123456789',role:'unknown',state:'completed',trackingNo:null}}:original(id,m);
 await ui('start',{kind:'tracking'});await new Promise(r=>setTimeout(r,1200));await pulse();assert.equal(data.job.counts.skipped,1);assert.equal(requests.some(x=>x.name==='marketplace_extension_probe'||x.name==='reconcile_marketplace_tracking'||x.name==='marketplace_extension_receipt'),false);assert.equal(submitClicks,0);assert.equal(data.events.some(e=>e.text==='購入者・取引状態を判定できません'),false);await ui('stop');
 }finally{chrome.tabs.sendMessage=original;data.job=null;}
});

test('実登録が一致するプロファイルだけ確認済み追跡を本番化し、対象外操作を拒否する',async()=>{
 reset();const {PRODUCTION_PLAN}=await import('../../tools/fleamarket-extension/production-plan.js');const id='51502a66-28a6-4af0-81ea-660e63d8b66c';data.diagnosticInstance=id;data.lastAppliedProductionPlan=null;data.operationPolicy=null;data.settings.accounts.forEach(a=>a.enabled=false);
 for(const e of PRODUCTION_PLAN.profiles[id]){const a=data.settings.accounts.find(a=>a.id===e.id);Object.assign(a,{enabled:true,listUrl:e.listUrl,identity:{selector:'#me',text:e.name}});}
 await import('../../tools/fleamarket-extension/background.js?rollout-valid');await new Promise(r=>setTimeout(r,1200));assert.equal(data.settings.mode,'tracking');assert.equal(data.lastAppliedProductionPlan,PRODUCTION_PLAN.id);assert.deepEqual(data.operationPolicy,['tracking','receipt','purchases']);assert.equal(data.settings.purchaseImportEnabled,true);assert.equal((await ui('start',{kind:'messages'})).ok,false);assert.equal((await ui('start',{kind:'purchases'})).ok,true);await ui('stop');assert.equal(data.settings.recipes.flea.trackingEnabled,true);assert.equal(data.settings.recipes.flea.verified,false);assert.equal(data.settings.recipes.rakuma.trackingEnabled,true);assert.equal(data.settings.recipes.rakuma.receiptVerified,undefined);await pulse();assert.equal(requests.some(x=>x.name==='extension_marketplace_message_queue'),false);await ui('stop');
});
test('登録名が確認時と違う場合は本番設定を適用せず診断を維持する',async()=>{
 reset();data.diagnosticInstance='51502a66-28a6-4af0-81ea-660e63d8b66c';data.lastAppliedProductionPlan=null;data.operationPolicy=null;const a=data.settings.accounts[0];a.enabled=false;const b=data.settings.accounts[1];Object.assign(b,{enabled:true,listUrl:'https://jp.mercari.com/mypage/purchases',identity:{selector:'#me',text:'別人'}});
 await import('../../tools/fleamarket-extension/background.js?rollout-wrong-name');await new Promise(r=>setTimeout(r,100));assert.equal(data.settings.mode,'diagnostic');assert.equal(data.lastAppliedProductionPlan,null);assert.equal(requests.some(x=>x.name==='reconcile_marketplace_tracking'),false);assert.equal(data.job,null);
});

test('追跡有効化は実地検証フラグと分離し、指定RPCの登録経路だけを許可する',async()=>{
 reset('tracking');data.diagnosticInstance='unknown';data.settings.recipes.mercari={scope:'main',verified:false,trackingEnabled:true};assert.equal((await ui('save',{settings:data.settings})).ok,true);await ui('start',{kind:'tracking'});await new Promise(r=>setTimeout(r,1200));await pulse();assert.equal(requests.filter(x=>x.name==='reconcile_marketplace_tracking').length,1);assert.equal(submitClicks,0);await ui('stop');
});

test('巡回中に保留された設定は終了後のアラームで適用し、検証済みとは偽らない',async()=>{
 reset('tracking');const {PRODUCTION_PLAN}=await import('../../tools/fleamarket-extension/production-plan.js');const id='51502a66-28a6-4af0-81ea-660e63d8b66c';data.diagnosticInstance=id;data.lastAppliedProductionPlan=null;data.settings.accounts.forEach(a=>a.enabled=false);
 for(const e of PRODUCTION_PLAN.profiles[id])Object.assign(data.settings.accounts.find(a=>a.id===e.id),{enabled:true,listUrl:e.listUrl,identity:{selector:'#me',text:e.name}});
 data.job={kind:'tracking'};await import('../../tools/fleamarket-extension/background.js?deferred-rollout');await new Promise(r=>setTimeout(r,80));assert.equal(data.lastAppliedProductionPlan,null);data.job=null;
 await pulse();assert.equal(data.lastAppliedProductionPlan,PRODUCTION_PLAN.id);assert.equal(data.settings.recipes.flea.trackingEnabled,true);assert.equal(data.settings.recipes.rakuma.trackingEnabled,true);assert.equal(data.settings.recipes.flea.verified,false);assert.equal(submitClicks,0);await ui('stop');data.diagnosticInstance='unknown';
});

test('定時巡回のアクセス実数を完了記録と診断に保存する',async()=>{
 reset('tracking');data.diagnosticInstance='unknown';data.trackingAccessHistory=[];await ui('start',{kind:'tracking'});await new Promise(r=>setTimeout(r,1200));await pulse();await ui('stop');const x=(await ui('export')).value;assert.equal(x.lastRun.tracking.access.total,2);assert.equal(x.lastRun.tracking.access.accounts[0].list,1);assert.equal(x.lastRun.tracking.access.accounts[0].detail,1);assert.equal(x.trackingAccessHistory.length,1);assert.equal(x.trackingAccessHistory[0].completed,true);
});

test('再確認の続行は手動・在庫先行の追跡処理に限定し、評価ジョブを進めない',async()=>{reset('tracking');data.job={kind:'receipt',strategy:'inventory-first',manual:true};assert.equal((await ui('continueTracking')).ok,false);assert.equal(submitClicks,0);data.job=null;assert.equal((await ui('continueTracking')).value.done,true);});

test('自動再連携は元の管理者と異なるログインを拒否する',async()=>{
 reset();const jwt=sub=>'header.'+Buffer.from(JSON.stringify({sub})).toString('base64url')+'.signature';data.session.access_token=jwt('previous-admin');adminTabs=[{id:99,url:'https://bussan-admin.vercel.app/'}];const original=chrome.scripting.executeScript;let creations=0;
 try{chrome.scripting.executeScript=async({args})=>{if(args){creations++;throw Error('must not create another user session');}return [{result:{access_token:jwt('other-admin'),email:'other@example.test'}}];};const r=await ui('connect',{automatic:true});assert.equal(r.ok,false);assert.match(r.error,/管理者が違います/);assert.equal(creations,0);}finally{chrome.scripting.executeScript=original;adminTabs=[];}
});
test('連携が失効して管理アプリ未ログインなら巡回せず再試行を間引く',async()=>{
 reset('tracking');data.authProblem={at:new Date().toISOString(),reason:'refresh-invalid'};delete data.authRecoveryAttempt;adminTabs=[];await pulse();const first=data.authRecoveryAttempt.at,errors=data.events.filter(e=>e.text.includes('再連携待ち')).length;assert.equal(data.job,null);await pulse();assert.equal(data.authRecoveryAttempt.at,first);assert.equal(data.events.filter(e=>e.text.includes('再連携待ち')).length,errors);assert.equal(requests.some(r=>r.name==='marketplace_tracking_candidates'),false);delete data.authProblem;delete data.authRecoveryAttempt;
});

test('新規タブ禁止では既存タブだけを使い、本人確認後に番号照合し元のURLへ戻す',async()=>{
 reset('tracking');data.settings.openNewTabs=false;data.settings.accounts[0].identity.pageUrl='https://jp.mercari.com/mypage/purchases';const original={...chrome.tabs};let created=0,removed=0;const first='https://jp.mercari.com/transaction/m123456789';let url=first;
 try{chrome.tabs.query=async()=>[{id:55,url}];chrome.tabs.get=async()=>({id:55,status:'complete',url});chrome.tabs.update=async(id,x)=>{if(x.url)url=x.url;return {id,url};};chrome.tabs.create=async()=>{created++;throw Error('new tab forbidden');};chrome.tabs.remove=async()=>{removed++;throw Error('user tab forbidden');};chrome.tabs.sendMessage=async(id,m)=>m.type==='fm:identity'?{ok:true,value:{confirmed:true}}:original.sendMessage(id,m);
 await ui('start',{kind:'tracking'});await new Promise(r=>setTimeout(r,2300));for(let i=0;i<6&&data.job;i++){await pulse();await new Promise(r=>setTimeout(r,1400));}assert.equal(data.job,null);assert.equal(created,0);assert.equal(removed,0);assert.equal(url,first);assert.ok(requests.some(r=>r.name==='reconcile_marketplace_tracking'));await ui('stop');
 }finally{Object.assign(chrome.tabs,original);}
});
test('起動画面以外の拡張ページ・サイトから起動用タブ追加を要求できない',()=>{for(const url of ['https://auctions.yahoo.co.jp/my/won','chrome-extension://unit/popup.html']){let replied=false;assert.equal(listener({type:'launchSites',launchTabId:5},{id:'unit',url},()=>replied=true),false);assert.equal(replied,false);}});
