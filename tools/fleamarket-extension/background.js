import {runSellerReadOnlyInspection} from './seller-inspection.js?v=0.1.134';
import {supplierQueuedOperations} from './supplier-runtime.js';
import {sellerDaily,sellerQueuedOperations,openSellerSession,runSellerSaleRepair} from './seller-runtime.js?v=0.1.134';
import {readSellerInventory} from './sales-status.js';
import {openLauncherSites,missingTabRecovery,desktopRequestApplies} from './launcher.js';
import {borrowSiteTab,restoreSiteTab} from './existing-tabs.js';
import {allowedSiteRedirect} from './navigation.js';
import {ensureAlarms} from './alarm-schedule.js';
import {purchaseImportStep} from './purchase-import.js';
import {scheduleDue} from './schedule.js';
import {inventoryFirstStep} from './inventory-first.js';
import {newAccessMetrics,incrementAccess} from './access-metrics.js';
import {PRODUCTION_PLAN} from './production-plan.js';
import {SITES,API,PUBLIC_KEY,assertSiteUrl,siteFor,eligible,jstDay,dueTime,nextTime,settingsDefault,validateSettings,trackingEnabled} from './core.js';
import {rpc,connectSession} from './api.js';
import {checkPackageUpdate,LOADED_BUILD} from './updates.js';
const STORE=chrome.storage.local;
let sellerBusy=false;let busy=false;let focusRestore=null;let dailyStarting=false;let launcherChain=Promise.resolve();const readyLaunchTabs=new Set();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function getSettings(){const {settings}=await STORE.get('settings');return settings||settingsDefault();}
async function log(kind,text,extra={}){const {events=[]}=await STORE.get('events');events.unshift({at:new Date().toISOString(),kind,text,...extra});await STORE.set({events:events.slice(0,200)});await chrome.action.setBadgeText({text:kind==='error'?'!':''});}
async function schedule(fired=null){await ensureAlarms(chrome.alarms,await getSettings(),{fired});}
let initialization;let initializationPending=false;
function initialize(){if(!initialization){initializationPending=true;initialization=initializeOnce().finally(()=>{initializationPending=false;});}return initialization;}
async function initializeOnce(){const previous=await STORE.get(['loadedBuild','authProblem']);if(previous.authProblem&&previous.loadedBuild!==LOADED_BUILD)await STORE.remove('authRecoveryAttempt');await STORE.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await STORE.set({loadedBuild:LOADED_BUILD});if(!(await STORE.get('settings')).settings)await STORE.set({settings:settingsDefault()});const tabSettings=await getSettings();if(tabSettings.openNewTabs!==false){tabSettings.openNewTabs=false;await STORE.set({settings:tabSettings});}await schedule();if(!(await STORE.get('authProblem')).authProblem)await applyProductionPlan();await reportRuntimeStatus();const version=chrome.runtime.getManifest().version;if((await getSettings()).openNewTabs!==false&&PRODUCTION_PLAN.inspectPurchases&&(await STORE.get('lastPurchaseInspection')).lastPurchaseInspection!==PRODUCTION_PLAN.id){await STORE.set({lastPurchaseInspection:PRODUCTION_PLAN.id});await chrome.tabs.create({url:chrome.runtime.getURL('inspect-purchases.html'),active:false});}if((await getSettings()).openNewTabs!==false&&PRODUCTION_PLAN.bootstrapPurchases&&(await STORE.get('lastPurchaseBootstrap')).lastPurchaseBootstrap!==PRODUCTION_PLAN.id){await STORE.set({lastPurchaseBootstrap:PRODUCTION_PLAN.id});await chrome.tabs.create({url:chrome.runtime.getURL('purchase-run.html'),active:false});}if((await getSettings()).openNewTabs!==false&&PRODUCTION_PLAN.retryTracking&&(await STORE.get('lastRepairRetry')).lastRepairRetry!==PRODUCTION_PLAN.id){await STORE.set({lastRepairRetry:PRODUCTION_PLAN.id});await chrome.tabs.create({url:chrome.runtime.getURL('retry-tracking.html'),active:false});}if((await getSettings()).openNewTabs!==false&&PRODUCTION_PLAN.inspectLists&&(await STORE.get('lastListingInspection')).lastListingInspection!==version){await STORE.set({lastListingInspection:version});await chrome.tabs.create({url:chrome.runtime.getURL('inspect-list.html'),active:false});}const s=await getSettings();if(!PRODUCTION_PLAN.cancelled&&s.mode==='diagnostic'&&s.accounts.some(a=>a.enabled)&&(await STORE.get('lastDiagnosticVersion')).lastDiagnosticVersion!==version){await STORE.set({lastDiagnosticVersion:version,pendingDiagnosticStart:version});await diagnosticReport();await runPendingDiagnostic();void step();}await processDesktopLaunchRequest();}
async function runPendingDiagnostic(){const {pendingDiagnosticStart,job}=await STORE.get(['pendingDiagnosticStart','job']);if(!pendingDiagnosticStart||job)return;const s=await getSettings();if(s.mode!=='diagnostic'){await STORE.remove('pendingDiagnosticStart');return;}try{await start('tracking',true);await STORE.remove('pendingDiagnosticStart');await diagnosticReport();}catch(e){await STORE.remove('pendingDiagnosticStart');await log('error','更新後の確認巡回を開始できません: '+e.message);await diagnosticReport();}}
async function reportRuntimeStatus(){if((await STORE.get('authProblem')).authProblem)return;const s=await getSettings(),{diagnosticInstance}=await STORE.get('diagnosticInstance');if(!diagnosticInstance)return;try{await rpc('marketplace_extension_runtime_report',{p_profile_id:diagnosticInstance,p_version:chrome.runtime.getManifest().version,p_build:LOADED_BUILD,p_mode:s.mode,p_tracking_policy:s.trackingPolicy||'legacy',p_tracking_hour:s.trackingHour,p_accounts:s.accounts.filter(a=>a.enabled).map(a=>a.id)});}catch(e){await log('error','設定反映の報告: '+e.message);}}
async function applyProductionPlan(){
 const {diagnosticInstance,lastAppliedProductionPlan,job}=await STORE.get(['diagnosticInstance','lastAppliedProductionPlan','job']);
 const expected=PRODUCTION_PLAN.profiles[diagnosticInstance];if(!expected||lastAppliedProductionPlan===PRODUCTION_PLAN.id||job)return;
 const s=await getSettings(),enabled=s.accounts.filter(a=>a.enabled);
 if(enabled.length!==expected.length||expected.some(e=>!enabled.some(a=>a.id===e.id&&a.identity?.text===e.name&&a.listUrl===e.listUrl)))throw new Error('本番切り替え: アカウント登録が確認時から変更されています');
 if(await rpc('is_admin')!==true)throw new Error('本番切り替え: 管理者連携を確認できません');
 s.mode=PRODUCTION_PLAN.mode;if(PRODUCTION_PLAN.purchaseImportEnabled===true)s.purchaseImportEnabled=true;if(PRODUCTION_PLAN.trackingPolicy==='inventory-first')s.trackingHour=1;if(PRODUCTION_PLAN.trackingPolicy)s.trackingPolicy=PRODUCTION_PLAN.trackingPolicy;s.recipes={...s.recipes,...structuredClone(PRODUCTION_PLAN.recipes)};
 await saveSettings(s);await STORE.set({lastAppliedProductionPlan:PRODUCTION_PLAN.id,operationPolicy:PRODUCTION_PLAN.purchaseImportEnabled?['tracking','receipt','purchases']:['tracking','receipt']});
 await log('info',PRODUCTION_PLAN.cancelled?'旧方式の自動巡回を停止しました':'在庫先行の追跡番号登録を毎日午前1時に設定しました。受け取り評価は停止中です',{sites:Object.keys(PRODUCTION_PLAN.recipes)});
 await diagnosticReport(true);if(PRODUCTION_PLAN.mode==='tracking'&&PRODUCTION_PLAN.trackingPolicy!=='inventory-first'){await start('tracking',true);void step();}
}
async function saveSettings(s){validateSettings(s);const {job}=await STORE.get('job');if(job)throw new Error('巡回中は設定を変更できません。先に停止してください');
  if(s.mode==='full'&&!s.migrationConfirmed)throw new Error('既存Codex処理の停止と評価画面の検証後に切り替えてください');
  if(s.mode==='tracking'&&!s.accounts.some(a=>a.enabled&&trackingEnabled(s.recipes[a.site])))throw new Error('追跡番号登録を有効にしたサイト設定が必要です');
  if(s.mode==='full')for(const a of s.accounts.filter(a=>a.enabled)){const r=s.recipes[a.site];if(!r?.verified)throw new Error(a.label+'の実画面検証が未完了です');if(s.mode==='full'&&!r.receiptVerified)throw new Error(a.label+'の評価画面検証が未完了です');}
  await STORE.set({settings:s});await schedule();return {saved:true};}
async function recordTrackingAccess(account,kind){
 const {job,trackingAccess}=await STORE.get(['job','trackingAccess']);
 if(job?.kind!=='tracking')return;
 if(!trackingAccess||trackingAccess.runId!==job.id)return;
 await STORE.set({trackingAccess:incrementAccess(trackingAccess,account,kind)});
}
async function content(tabId,type,args={}){
  const account=args.account;
  if(account?.identity?.pageUrl&&type!=='identity'){
    assertSiteUrl(account.site,account.identity.pageUrl);if(!['rakuma','mercari','flea','auctions'].includes(account.site))throw new Error('アカウント確認ページが不正です');
    if(!['list','detail','preflight','submit','success','messageDetail','sendMessage','purchaseDetail','purchaseMore'].includes(type))throw new Error('アカウント確認の処理種別が不正です');
    const target=await chrome.tabs.get(tabId);assertSiteUrl(account.site,target.url);
    const noNewTabs=(await getSettings()).openNewTabs===false;
    const borrowed=noNewTabs?await borrowSiteTab(chrome.tabs,account.site):null;
    const checkTab=noNewTabs?await chrome.tabs.update(borrowed.id,{url:account.identity.pageUrl}):await chrome.tabs.create({url:account.identity.pageUrl,active:false,...await readingWindow()});
    if(borrowed)borrowed.lastUrl=account.identity.pageUrl;
    try{
      await recordTrackingAccess(account,'identity');
      await loaded(checkTab.id,account.site);
      const confirmed=await content(checkTab.id,'identity',{account:{...account,_identityConfirmed:false}});
      if(confirmed.auth)throw new Error(confirmed.auth);
      if(confirmed.confirmed!==true)throw new Error('ログイン中アカウントを確認できません');
    }finally{if(borrowed){await restoreSiteTab(chrome.tabs,borrowed);if(checkTab.id===tabId)await loaded(tabId,account.site);}else await chrome.tabs.remove(checkTab.id).catch(()=>{});}
    args={...args,account:{...account,_identityConfirmed:true}};
  }
  let r;const message={type:'fm:'+type,...args};try{r=await chrome.tabs.sendMessage(tabId,message);}catch(e){
  // 導入前から開いていたページにはcontent scriptが未配置の場合がある。
  if(!/Receiving end does not exist|Could not establish connection/i.test(e.message||''))throw e;
  const tab=await chrome.tabs.get(tabId);if(!siteFor(tab.url))throw e;
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
  r=await chrome.tabs.sendMessage(tabId,message);
}if(!r?.ok)throw new Error(r?.error||'サイト読み取りスクリプトに接続できません');return r.value;}
async function loaded(tabId,site){const until=Date.now()+18000;while(Date.now()<until){const tab=await chrome.tabs.get(tabId);if(tab.status==='complete'){if(siteFor(tab.url)!==site){const u=new URL(tab.url),auth=/login|signin|auth|id\.rakuten|account/.test(u.pathname+' '+u.hostname);throw new Error((auth?'ログイン切れ':'画面確認待ち')+': 対象サイト外への移動 ('+u.hostname+')');}await wait(700);return;}await wait(300);}throw new Error('ページの読み込みが時間切れになりました');}
async function readingWindow(){if(!chrome.windows)return {};const windows=await chrome.windows.getAll({windowTypes:['normal']});let w=windows.find(w=>w.state!=='minimized'&&w.width>300&&w.height>200)||windows[0];if(!w)return {};if(w.state==='minimized'||w.width<=300||w.height<=200){await chrome.windows.update(w.id,{state:'normal'});await chrome.windows.update(w.id,{width:1200,height:900,focused:true});}return {windowId:w.id};}
async function navigate(job,account,url){assertSiteUrl(account.site,url);if(job.tabId){try{await chrome.tabs.get(job.tabId);}catch{job.tabId=null;}}
  const window=await readingWindow();const foreground=['mercari','rakuma'].includes(account.site);let previous;if(foreground)[previous]=await chrome.tabs.query({active:true,currentWindow:true});
  if((await getSettings()).openNewTabs===false&&!job.tabId){job.borrowedTab=await borrowSiteTab(chrome.tabs,account.site);job.tabId=job.borrowedTab.id;await STORE.set({job});}
  if(job.borrowedTab){const current=await chrome.tabs.get(job.tabId);if(current.url!==job.borrowedTab.lastUrl)throw Error('画面確認待ち: 巡回中に既存タブが変更されました');job.borrowedTab.lastUrl=url;await STORE.set({job});}
  if(job.tabId)await chrome.tabs.update(job.tabId,{url,active:foreground});else{job.tabId=(await chrome.tabs.create({url,active:foreground,...window})).id;await STORE.set({job});}
  await recordTrackingAccess(account,job.stage==='list'?'list':job.stage==='inventory'?'identity':'detail');
  if(foreground&&previous?.id&&previous.id!==job.tabId)focusRestore={previous:previous.id,scan:job.tabId};
  const scanTab=await chrome.tabs.get(job.tabId);if(foreground&&chrome.windows&&Number.isInteger(scanTab.windowId)){const w=await chrome.windows.get(scanTab.windowId);if(w.state==='minimized')await chrome.windows.update(w.id,{state:'normal'});if(w.state!=='maximized'&&(w.width<1000||w.height<700))await chrome.windows.update(w.id,{width:1200,height:900});await chrome.windows.update(w.id,{focused:true});}await loaded(job.tabId,account.site);
  const arrived=(await chrome.tabs.get(job.tabId)).url;
  if(job.borrowedTab&&arrived!==url){if(!allowedSiteRedirect(account.site,url,arrived))throw Error('画面確認待ち: 予期しないページへの移動');job.borrowedTab.lastUrl=arrived;await STORE.set({job});}
  return {requestedUrl:url,finalUrl:arrived};
}
function taskArgs(account,status,kind,details,itemId=null){const label={tracking:'追跡番号照合',receipt:'受け取り評価',purchases:'仕入れリストの自動取得'}[kind]||kind;return {p_marketplace:SITES[account.site].db[0],p_account_label:account.label,p_marketplace_item_id:itemId,p_site_tracking_no:null,p_confirmation_status:status,p_details:`処理種別=${label}; 拡張機能; ${details}`};}
async function task(account,status,kind,details,itemId=null){const args=taskArgs(account,status,kind,details,itemId);try{await rpc('reconcile_marketplace_tracking',args);}catch(e){const {outbox=[]}=await STORE.get('outbox');const key=account.id+':'+status+':'+(itemId||'');const filtered=outbox.filter(x=>x.key!==key);filtered.push({key,args});await STORE.set({outbox:filtered.slice(-200)});await log('error','ダッシュボードへ未送信: '+e.message,{account:account.label,status,itemId});}}
async function flushOutbox(){const {outbox=[]}=await STORE.get('outbox');if(!outbox.length)return;try{await rpc('reconcile_marketplace_tracking',outbox[0].args);await STORE.set({outbox:outbox.slice(1)});}catch{}}
function prepareAccount(a){const copy=structuredClone(a);if(copy.site==='auctions'&&copy.listUrl==='https://auctions.yahoo.co.jp/my/won'&&copy.identity)copy.identity.pageUrl=copy.listUrl;if(copy.site==='flea'&&copy.listUrl==='https://paypayfleamarket.yahoo.co.jp/my/purchase'&&copy.identity)copy.identity.pageUrl=copy.listUrl;return copy;}
async function diagnosticReport(force=false){if((await getSettings()).openNewTabs===false)return;if(force||(await getSettings()).mode==='diagnostic')await chrome.tabs.create({url:chrome.runtime.getURL('report.html'),active:false}).catch(()=>{});}
async function capturePage(job,a,stage){if(job.settings.mode!=='diagnostic'&&job.kind!=='purchases')return;try{const d=await content(job.tabId,'diagnostic');const {pages=[]}=await STORE.get('pages');pages.push({at:new Date().toISOString(),account:a.label,stage,...d});await STORE.set({pages:pages.slice(-60)});}catch{}}
async function start(kind,manual=false){if(sellerBusy)throw Error('販売サイトの確認中です。完了後に操作してください');if(!['tracking','receipt','messages','purchases'].includes(kind))throw new Error('処理種別が不正です');const {job,operationPolicy}=await STORE.get(['job','operationPolicy']);if(operationPolicy&&!operationPolicy.includes(kind))throw new Error('この運用では発送・メッセージ・購入などは実行しません');if(job)throw new Error('別の巡回を実行中です');const s=await getSettings();const accounts=s.accounts.filter(a=>a.enabled).map(prepareAccount);if(!accounts.length)throw new Error('このChromeプロファイルのアカウントを登録してください');
  if(kind==='purchases'&&s.mode==='diagnostic')throw new Error('診断モードでは仕入れリストへ追加しません');if(kind==='receipt'&&s.mode!=='full')throw new Error('受け取り評価は実画面検証と切り替え後に有効になります');
  // 診断モードにはSupabaseの読み取り照合も含むが、登録・評価送信は行わない。
  if(await rpc('is_admin')!==true)throw new Error('管理アプリとの連携を確認してください');
  const outbox=kind==='messages'?await rpc('extension_marketplace_message_queue',{p_marketplaces:[...new Set(accounts.flatMap(a=>SITES[a.site].db))]}):[];
  await STORE.set({job:{id:crypto.randomUUID(),kind,manual,day:jstDay(),accountIndex:0,stage:'list',pageUrl:accounts[0].listUrl,seenPages:[],urls:[],index:0,tabId:null,counts:{checked:0,updated:0,rated:0,imported:0,skipped:0,errors:0},settings:s,accounts,outbox}});
  if(kind==='tracking'){const {job}=await STORE.get('job');if(s.trackingPolicy==='inventory-first'){job.strategy='inventory-first';job.stage='inventory';await STORE.set({job});}await STORE.set({trackingAccess:newAccessMetrics(job)});}if(kind==='purchases'){if(s.mode==='diagnostic')throw new Error('診断モードでは仕入れリストへ追加しません');const {job}=await STORE.get('job');job.strategy='purchase-import';job.stage='purchase-context';await STORE.set({job});}
  await log('info',kind==='tracking'?'追跡番号の巡回を開始':kind==='messages'?'取引メッセージの同期を開始':kind==='purchases'?'購入履歴の取り込みを開始':'受け取り評価の巡回を開始');return {started:true};}
async function finish(job){if(['purchases','tracking'].includes(job.kind)){const a=job.accounts[Math.min(job.accountIndex,job.accounts.length-1)];await rpc('marketplace_purchase_lease',{p_marketplace:SITES[a.site].db[0],p_owner:job.id,p_action:'release'}).catch(()=>{});}if(job.borrowedTab)await restoreSiteTab(chrome.tabs,job.borrowedTab).catch(()=>{});else if(job.tabId)await chrome.tabs.remove(job.tabId).catch(()=>{});delete job.borrowedTab;const {lastRun={},trackingAccess,trackingAccessHistory=[]}=await STORE.get(['lastRun','trackingAccess','trackingAccessHistory']);const access=job.kind==='tracking'&&trackingAccess?.runId===job.id?{...trackingAccess,finishedAt:new Date().toISOString(),completed:true}:null;lastRun[job.kind]={day:job.day,manual:job.manual===true,at:new Date().toISOString(),counts:job.counts,...(access?{access}:{})};await STORE.set({lastRun,job:null,...(access?{trackingAccessHistory:[...trackingAccessHistory,access].slice(-40)}:{})});await log('info','巡回終了',job.counts);await diagnosticReport(true);}
async function nextAccount(job){if(['purchases','tracking'].includes(job.kind))await rpc('marketplace_purchase_lease',{p_marketplace:SITES[job.accounts[job.accountIndex].site].db[0],p_owner:job.id,p_action:'release'}).catch(()=>{});if(job.borrowedTab)await restoreSiteTab(chrome.tabs,job.borrowedTab).catch(()=>{});else if(job.tabId)await chrome.tabs.remove(job.tabId).catch(()=>{});delete job.borrowedTab;job.tabId=null;job.accountIndex++;job.urls=[];job.index=0;job.seenPages=[];job.stage=job.strategy==='inventory-first'?'inventory':job.strategy==='purchase-import'?'purchase-context':'list';job.pageUrl=job.accounts[job.accountIndex]?.listUrl;if(job.accountIndex>=job.accounts.length){if(job.kind==='messages')for(const entry of job.outbox||[])await rpc('extension_finish_marketplace_message',{p_id:entry.id,p_status:'failed',p_note:'このChromeプロファイルの購入一覧に該当する取引が見つかりません'}).catch(()=>{});return finish(job);}await STORE.set({job});}
function receiptArgs(a,itemId,action,token=null,details=null){return {p_action:action,p_marketplace:SITES[a.site].db[0],p_item_id:itemId,p_account_label:a.label,p_token:token,p_details:details};}
async function recoverSend(job,a){
  const p=job.pendingReceipt;
  if(p){await rpc('marketplace_extension_receipt',receiptArgs(a,p.itemId,'unknown',p.token,'Chrome停止等により送信結果が未確認')).catch(()=>{});await task(a,'評価結果要確認','受け取り評価','送信済みか判定できないため自動再送を停止しています',p.itemId);}
  delete job.pendingReceipt;job.stage='detail';job.index++;job.counts.errors++;await STORE.set({job});
}
async function step(){if(sellerBusy)return;if(await launchPending())return;if(busy)return;busy=true;try{
  let {job}=await STORE.get('job');if(!job){await flushOutbox();return;}
  const a=prepareAccount(job.accounts[job.accountIndex]),r=job.settings.recipes[a.site]||{};
  if(job.stage==='sending'){await recoverSend(job,a);return;}
  try{
    if(job.strategy==='purchase-import'){await purchaseImportStep(job,a,{rpc,navigate,read:content,save:async job=>STORE.set({job}),nextAccount,task,log,lease:async(job,a,action)=>rpc('marketplace_purchase_lease',{p_marketplace:SITES[a.site].db[0],p_owner:job.id,p_action:action}),dbSite:SITES[a.site].db[0],verifyAccount:async(job,a)=>{await navigate(job,a,a.identity.pageUrl||a.listUrl);const x=await content(job.tabId,'identity',{account:a});if(x.auth)throw new Error(x.auth);if(x.confirmed!==true)throw new Error('名前不一致: 登録名を確認できません');}});return;}if(job.strategy==='inventory-first'){if(await rpc('marketplace_purchase_lease',{p_marketplace:SITES[a.site].db[0],p_owner:job.id,p_action:'acquire'})!==true)return;await inventoryFirstStep(job,a,{rpc,navigate,read:content,save:async job=>STORE.set({job}),nextAccount,log,verifyAccount:async(job,a)=>{await navigate(job,a,a.identity.pageUrl||a.listUrl);const x=await content(job.tabId,'identity',{account:a});if(x.auth)throw new Error(x.auth);if(x.confirmed!==true)throw new Error('名前不一致: 登録名を確認できません');},dbSite:SITES[a.site].db[0]});return;}
    if(job.stage==='list'){
      if(job.seenPages.includes(job.pageUrl)||job.seenPages.length>=20)throw new Error('取引一覧のページ数または巡回重複を確認してください');
      const listRecipe=['messages','purchases'].includes(job.kind)?{...r,includeCompleted:true}:r;
      await navigate(job,a,job.pageUrl);await capturePage(job,a,'list');const data=await content(job.tabId,'list',{account:a,recipe:listRecipe});await capturePage(job,a,'list-after-wait');if(data.auth)throw new Error(data.auth);if(data.incomplete)throw new Error('購入一覧を読み込んでも取引を取得できません。0件完了と判定せず画面確認が必要です');
      if(job.kind==='purchases'){
        const result=await rpc('extension_sync_purchase_drafts',{p_marketplace:SITES[a.site].db[0],p_account_label:a.label,p_purchases:data.purchases||[]});
        const added=Number(result?.inserted)||0;job.counts.imported+=added;job.counts.checked+=(data.purchases||[]).length;
        if(added||data.purchases?.length)await log('info',`購入履歴を確認: 新規 ${added}件 / 検出 ${(data.purchases||[]).length}件`,{account:a.label});
        job.seenPages.push(job.pageUrl);
        if(data.nextUrl)job.pageUrl=data.nextUrl;else {await nextAccount(job);return;}
        await STORE.set({job});return;
      }
      if(job.settings.mode==='diagnostic'&&!data.links.length)await log('info','取引リンク0件。未完了取引がないとは未確認です',{account:a.label});
      job.seenPages.push(job.pageUrl);job.urls=[...new Set([...job.urls,...data.links])];if(job.urls.length>500)throw new Error('取引数が上限を超えました');
      if(job.settings.mode==='diagnostic'){job.urls=job.urls.slice(0,3);if(job.seenPages.length>=3)data.nextUrl=null;}
      if(data.nextUrl)job.pageUrl=data.nextUrl;else job.stage='detail';await STORE.set({job});return;
    }
    if(job.index>=job.urls.length){await nextAccount(job);return;}
    if(job.kind==='messages'){
      await navigate(job,a,job.urls[job.index]);
      const tx=await content(job.tabId,'messageDetail',{account:a,recipe:r});
      if(tx.auth)throw new Error(tx.auth);
      await rpc('extension_sync_marketplace_messages',{p_marketplace:SITES[a.site].db[0],p_item_id:tx.itemId,p_account_label:a.label,p_messages:tx.messages||[]});
      const queued=(job.outbox||[]).find(entry=>SITES[a.site].db.includes(entry.marketplace)&&entry.marketplace_item_id===tx.itemId);
      if(queued){
        const claimed=await rpc('extension_claim_marketplace_message',{p_id:queued.id,p_claimant:a.id+':'+a.label});
        job.outbox=job.outbox.filter(entry=>entry.id!==queued.id);
        if(claimed){
          let clicked=false;
          try{
            const sent=await content(job.tabId,'sendMessage',{account:a,recipe:r,itemId:tx.itemId,body:queued.body});
            clicked=sent.clicked===true;await loaded(job.tabId,a.site);await wait(1400);
            const updated=await content(job.tabId,'messageDetail',{account:a,recipe:r});
            await rpc('extension_sync_marketplace_messages',{p_marketplace:SITES[a.site].db[0],p_item_id:tx.itemId,p_account_label:a.label,p_messages:updated.messages||[]});
            const echoed=(updated.messages||[]).some(message=>message.body===queued.body&&message.author_role==='self');
            await rpc('extension_finish_marketplace_message',{p_id:queued.id,p_status:echoed?'sent':'uncertain',p_note:echoed?'取引画面に送信済みの文面を確認しました':'送信後の表示を確認できません。取引画面を確認してください'});
            await log(echoed?'info':'error',echoed?'取引メッセージを送信しました':'送信結果を要確認',{account:a.label,itemId:tx.itemId});
          }catch(error){
            await rpc('extension_finish_marketplace_message',{p_id:queued.id,p_status:clicked?'uncertain':'failed',p_note:clicked?'送信ボタン押下後の確認でエラー: '+error.message:error.message}).catch(()=>{});
            await log('error','取引メッセージ送信: '+error.message,{account:a.label,itemId:tx.itemId});
          }
        }
      }
      job.counts.checked++;job.index++;await STORE.set({job});return;
    }
    await navigate(job,a,job.urls[job.index]);const tx=await content(job.tabId,'detail',{account:a,recipe:r});await capturePage(job,a,'detail');if(tx.auth)throw new Error(tx.auth);job.counts.checked++;if(job.settings.mode==='diagnostic')await log('info','診断: 取引を読み取りました',{account:a.label,itemId:tx.itemId,role:tx.role,state:tx.state,trackingNo:tx.trackingNo});
    if(tx.role!=='buyer'||tx.state!=='pending'){job.counts.skipped++;if(tx.state!=='completed'&&(tx.role==='unknown'||tx.state==='unknown')){await log('error','購入者・取引状態を判定できません',{account:a.label,itemId:tx.itemId});if(job.settings.mode!=='diagnostic')await task(a,'画面確認待ち',job.kind,'購入者側の未完了取引か判断できません',tx.itemId);}job.index++;await STORE.set({job});return;}
    const match=await rpc('marketplace_extension_probe',{p_marketplace:SITES[a.site].db[0],p_item_id:tx.itemId});
    if(job.kind==='tracking'){
      if(job.settings.mode==='diagnostic'||!trackingEnabled(r)){if(job.settings.mode!=='diagnostic'&&!trackingEnabled(r))await task(a,'画面確認待ち','追跡番号','追跡画面の実地確認が未完了のため登録を保留しています',tx.itemId);await log('info','診断: 更新せず照合',{account:a.label,itemId:tx.itemId,count:match.count,trackingNo:tx.trackingNo,sku:match.items.map(x=>x.sku),inventoryStatus:match.items.map(x=>({sku:x.sku,inspected:!!x.inspected_at,cleaned:!!x.cleaned_at,trackingPresent:!!x.tracking_no})),eligibleForReceipt:eligible(match.items,tx).ok});}
      else{const result=await rpc('reconcile_marketplace_tracking',{p_marketplace:SITES[a.site].db[0],p_account_label:a.label,p_marketplace_item_id:tx.itemId,p_site_tracking_no:tx.trackingAmbiguous?null:tx.trackingNo,p_confirmation_status:null,p_details:'Chrome拡張機能; 購入者側・未完了確認済み'+(tx.trackingAmbiguous?'; サイトに複数の追跡番号があり要確認':'')});if(result.result==='updated')job.counts.updated++;await log('info',result.status||result.result,{account:a.label,itemId:tx.itemId,sku:result.sku});}
    }else{
      const check=eligible(match.items,tx);if(!check.ok){job.counts.skipped++;await log('info',check.reason,{account:a.label,itemId:tx.itemId});if(match.count!==1)await task(a,'評価処理保留','受け取り評価',check.reason,tx.itemId);}
      else{
        await content(job.tabId,'preflight',{account:a,recipe:r,itemId:tx.itemId});
        const reserved=await rpc('marketplace_extension_receipt',receiptArgs(a,tx.itemId,'reserve'));if(!reserved.eligible){job.counts.skipped++;await log('info',reserved.reason,{account:a.label,itemId:tx.itemId});}
        else{
          job.pendingReceipt={itemId:tx.itemId,token:reserved.token};job.stage='sending';await STORE.set({job});
          await rpc('marketplace_extension_receipt',receiptArgs(a,tx.itemId,'begin',reserved.token));
          await content(job.tabId,'submit',{account:a,recipe:r,itemId:tx.itemId});
          await loaded(job.tabId,a.site);await wait(1200);
          const result=await content(job.tabId,'success',{account:a,recipe:r,itemId:tx.itemId});
          if(result.auth||!result.success)throw new Error('評価送信後の完了表示が確認できません');
          await rpc('marketplace_extension_receipt',receiptArgs(a,tx.itemId,'complete',reserved.token,'サイトの完了表示を確認'));job.counts.rated++;delete job.pendingReceipt;job.stage='detail';await log('info','受け取り評価を完了',{account:a.label,itemId:tx.itemId,sku:check.sku});
        }
      }
    }
    job.index++;await STORE.set({job});
  }catch(e){
    job.counts.errors++;if(job.kind==='purchases'&&job.tabId)await capturePage(job,a,'purchase-error');await log('error',e.message,{account:a.label});
    if(job.stage==='sending'){await recoverSend(job,a);return;}
    if(job.settings.mode!=='diagnostic'){const status=/画面確認待ち/.test(e.message)?'画面確認待ち':/追加承認待ち/.test(e.message)?'追加承認待ち':/ログイン切れ/.test(e.message)?'ログイン切れ':/名前|アカウント|登録内容と一致/.test(e.message)?'名前不一致':'画面確認待ち';await task(a,status,job.kind,'サイト='+SITES[a.site].name+'; 名前='+a.identity.text+'; '+e.message);}
    // 認証・画面異常があるアカウントはこの回の巡回を停止。利用者用にタブを残す。
    job.tabId=null;await nextAccount(job);
  }
}finally{if(focusRestore){const restore=focusRestore;focusRestore=null;try{const [current]=await chrome.tabs.query({active:true,currentWindow:true});if(current?.id===restore.scan)await chrome.tabs.update(restore.previous,{active:true});}catch{}}busy=false;if(!(await STORE.get('job')).job)await checkPackageUpdate({runtime:chrome.runtime,storage:STORE,fetchFile:fetch,busy:()=>busy||sellerBusy,record:log}).catch(e=>log('error','更新確認: '+e.message));}}
async function recoverConnection(){
 const {authProblem,authRecoveryAttempt}=await STORE.get(['authProblem','authRecoveryAttempt']);
 if(!authProblem)return true;
 if(authRecoveryAttempt?.at&&Date.now()-Date.parse(authRecoveryAttempt.at)<15*60000)return false;
 await STORE.set({authRecoveryAttempt:{at:new Date().toISOString()}});
 try{
  const tabs=await chrome.tabs.query({url:['https://test-repo-delivery.vercel.app/*','https://bussan-admin.vercel.app/*']});
  if(!tabs.length)throw Error('既存の管理アプリのタブにログインしてください。新しいタブは開きません');
  await uiMessage({type:'connect',automatic:true});
  await log('info','ログイン済み管理アプリから連携を復旧しました。本日の未実行分を再開します');
  await reportRuntimeStatus();await diagnosticReport(true);return true;
 }catch(e){const reason=/管理者が違い/.test(e.message)?'admin-mismatch':/ログインして|ログインしてください|JWT|token.*expired/i.test(e.message)?'admin-login-required':'admin-link-required';await STORE.set({authRecoveryAttempt:{at:new Date().toISOString(),reason}});await log('error','定期巡回は管理アプリの再連携待ちです。ログイン済み管理アプリで連携を押してください',{reason});await diagnosticReport(true);return false;}
}
async function due(onlyPurchases=false){if(sellerBusy)return;if(await launchPending())return;if(dailyStarting)return;dailyStarting=true;try{return await dueOnce(onlyPurchases);}finally{dailyStarting=false;}}
async function dueOnce(onlyPurchases=false){if(!await recoverConnection())return;const s=await getSettings();const records=await STORE.get(['lastRun','scheduledRuns','trackingAccessHistory','job']);if(records.job)return;
  const {operationPolicy}=await STORE.get('operationPolicy');if(!operationPolicy||operationPolicy.includes('messages'))try{
    const sites=[...new Set(s.accounts.filter(a=>a.enabled).flatMap(a=>SITES[a.site].db))];
    if(sites.length&& (await rpc('extension_marketplace_message_queue',{p_marketplaces:sites})).length){await start('messages');return;}
  }catch(e){await log('error','メッセージ送信依頼の確認: '+e.message);}
  if(s.mode==='diagnostic')return;
  for(const [kind,hour] of [...(s.purchaseImportEnabled?[['purchases',s.trackingHour]]:[]),['tracking',s.trackingHour],['receipt',s.receiptHour]]){if(onlyPurchases&&kind!=='purchases')continue;if(kind==='receipt'&&s.mode!=='full')continue;if(scheduleDue(kind,hour,records)){await start(kind);const {scheduledRuns={}}=await STORE.get('scheduledRuns');scheduledRuns[kind]={day:jstDay(),startedAt:new Date().toISOString()};await STORE.set({scheduledRuns});break;}}
}
async function uiMessage(m){
  if(m.type==='saleStatus'){
 const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
 if(!tab||!['mercari','auctions'].includes(siteFor(tab.url)))throw new Error('対象の出品一覧を開いてください');
 const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:readSellerInventory});
 let updated=0,protectedCount=0,unmatched=0;
 for(const row of result.rows){const status=await rpc('sync_marketplace_sale_status',{p_channel:result.channel,p_serial:row.serial,p_status:row.status,p_observed_at:result.observedAt});if(status==='updated')updated++;else if(status==='protected'||status==='stale')protectedCount++;else unmatched++;}
 return {updated,protectedCount,unmatched};
 }

 if(m.type==='launchSites'){await initialize();const request=launcherChain.catch(()=>{}).then(()=>launchFromIcon(m));launcherChain=request;return request;}
  if(m.type==='continuePurchases'){const {job}=await STORE.get('job');if(job&&job.kind!=='purchases')return {waiting:true};if(!job)await due(true);const current=(await STORE.get('job')).job;if(current?.kind==='purchases')await step();return {done:!(await STORE.get('job')).job};}if(m.type==='state'){const {session,...state}=await STORE.get(['settings','events','job','lastRun','outbox','session','authProblem']);return {...state,job:state.job?{kind:state.job.kind,stage:state.job.stage,counts:state.job.counts,account:state.job.accounts[state.job.accountIndex]?.label}:null,connected:!!session?.access_token&&!state.authProblem};}
  if(m.type==='clearAccount'){
    if((await STORE.get('job')).job)throw new Error('巡回中は登録を削除できません。先に巡回を停止してください');
    const s=await getSettings(),a=s.accounts.find(x=>x.id===m.id);if(!a)throw new Error('対象アカウントが見つかりません');
    a.enabled=false;delete a.identity;delete a.listUrl;delete a._identityConfirmed;
    await STORE.set({settings:s});await log('info','名前と購入一覧の登録を削除しました',{account:a.label});return {cleared:true,label:a.label};
  }
  if(m.type==='save')return saveSettings(m.settings);
  if(m.type==='continueTracking'){const {job}=await STORE.get('job');if(!job)return {done:true};if(job.kind!=='tracking'||job.strategy!=='inventory-first'||!job.manual)throw new Error('手動の在庫先行巡回だけを続行できます');if(busy)return {busy:true};await step();return {continued:true};}
  if(m.type==='start'){if(m.repairPlan){if(m.kind!=='purchases'||m.repairPlan!==PRODUCTION_PLAN.id)throw new Error('取得の確認要求が不正です');if((await STORE.get('lastPurchaseRepairStart')).lastPurchaseRepairStart===m.repairPlan)return {started:false};await STORE.set({lastPurchaseRepairStart:m.repairPlan});}const result=await start(m.kind,true);void step();return result;}
  if(m.type==='stop'){await STORE.remove('pendingDiagnosticStart');if(busy)throw new Error('処理中です。現在の1件が終わってから停止してください');const {job}=await STORE.get('job');if(job?.pendingReceipt)await recoverSend(job,job.accounts[job.accountIndex]);if(job)await finish(job);return {stopped:true};}
  if(m.type==='disconnect'){if((await STORE.get('job')).job)throw new Error('先に巡回を停止してください');await STORE.remove(['session','authProblem','authRecoveryAttempt']);return {disconnected:true};}
  if(m.type==='connect'){
    if(m.automatic===true){const {session}=await STORE.get('session');if(!session?.access_token)throw Error('手動で連携してください');}
    const tabs=await chrome.tabs.query({url:['https://test-repo-delivery.vercel.app/*','https://bussan-admin.vercel.app/*']});
    if(!tabs.length)throw new Error('既存の管理アプリのタブにログインして連携してください。新しいタブは開きません');
    let existing,adminTab,mismatched=false;
    const {session:linked}=await STORE.get('session');
    const subject=token=>{try{return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub;}catch{return null;}};
    for(const candidate of tabs){try{
      const [{result:current}]=await chrome.scripting.executeScript({target:{tabId:candidate.id},func:()=>{const raw=localStorage.getItem('sb-xgoppuqoqeppckyunnvx-auth-token');try{const s=JSON.parse(raw);return s?{access_token:s.access_token,email:s.user?.email}:null;}catch{return null;}}});
      if(!current?.access_token||!current.email)continue;
      if(m.automatic===true&&(!subject(linked?.access_token)||subject(linked.access_token)!==subject(current.access_token))){mismatched=true;continue;}
      if(await rpc('is_admin',{},current.access_token)!==true)continue;
      existing=current;adminTab=candidate;break;
    }catch{}}
    if(!existing)throw Error(mismatched?'連携元の管理者が違います。手動で連携してください':'管理アプリにログインしてから再度連携してください');
    // 既存アプリのrefresh tokenを共有せず、アプリの既存ログイン処理で独立したセッションを作る。
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:adminTab.id},args:[API,PUBLIC_KEY,existing.email],func:async(api,key,email)=>{
      const r=await fetch(api+'/functions/v1/email-only-login',{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email}),signal:AbortSignal.timeout(20000)});
      const data=await r.json();if(!r.ok)throw new Error(data.error||'連携用ログインに失敗しました');return data.session;
    }});
    return connectSession(result);
  }
  if(m.type==='registerSite'){
    const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});const site=siteFor(tab?.url);
    if(!['mercari','flea','rakuma'].includes(site))throw new Error('メルカリ・Yahoo!フリマ・ラクマの購入一覧を開いてください');
    const s=await getSettings(),a=s.accounts.find(x=>x.id===m.id);
    if(!a||a.site!==site)throw new Error('対象アカウントで、開いているサイトの1または2を選んでください');
    if(site==='rakuma')return uiMessage({type:'registerRakuma'});
    if((await STORE.get('job')).job)throw new Error('先に巡回を停止してください');
    const result=await content(tab.id,'autoIdentity',{site});a.identity=result.identity;
    if(!a.identity?.selector||!a.identity.text||a.identity.pageUrl!==new URL(tab.url).origin+new URL(tab.url).pathname)throw new Error('アカウント確認情報を取得できません');
    validateSettings(s);
    const data=await content(tab.id,'list',{account:a,recipe:s.recipes[site]||{}});if(data.auth)throw new Error(data.auth);
    a.listUrl=a.identity.pageUrl;a.enabled=true;validateSettings(s);await STORE.set({settings:s});await log('info','アカウントと購入一覧を自動登録しました',{account:a.label});await diagnosticReport();return {registered:true,label:a.label,name:a.identity.text};
  }
  if(m.type==='registerRakuma'){
    if((await STORE.get('job')).job)throw new Error('先に巡回を停止してください');
    const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
    if(!active||new URL(active.url).origin!=='https://fril.jp'||!['/mypage','/buy'].includes(new URL(active.url).pathname))throw new Error('ラクマのマイページか購入した商品を開いてください');
    const s=await getSettings(),a=s.accounts.find(x=>x.id==='rakuma-1');
    const created=[];
    try{
      const noNewTabs=(await getSettings()).openNewTabs===false;const profile=noNewTabs?(await chrome.tabs.query({url:'https://fril.jp/mypage'}))[0]:await chrome.tabs.create({url:'https://fril.jp/mypage',active:false});if(!profile)throw Error('既存のラクマのマイページを表示してください');if(!noNewTabs)created.push(profile.id);await loaded(profile.id,'rakuma');
      const result=await content(profile.id,'rakumaIdentity');a.identity=result.identity;
      if(!a.identity?.selector||!/^.{1,100}さんのマイページ$/.test(a.identity.text||'')||a.identity.pageUrl!=='https://fril.jp/mypage')throw new Error('ラクマのアカウント名を確認できません');
      let purchase=active;
      if(new URL(active.url).pathname!=='/buy'){purchase=noNewTabs?(await chrome.tabs.query({url:'https://fril.jp/buy'}))[0]:await chrome.tabs.create({url:'https://fril.jp/buy',active:false});if(!purchase)throw Error('既存のラクマ購入一覧を表示してください');if(!noNewTabs)created.push(purchase.id);await loaded(purchase.id,'rakuma');}
      const list=await content(purchase.id,'list',{account:a,recipe:s.recipes.rakuma||{}});if(list.auth)throw new Error(list.auth);
      a.listUrl='https://fril.jp/buy';a.enabled=true;validateSettings(s);await STORE.set({settings:s});
      await log('info','ラクマのアカウントと購入一覧を自動登録しました',{account:a.label});await diagnosticReport();return {registered:true,label:a.label,name:a.identity.text};
    }finally{for(const id of created)await chrome.tabs.remove(id).catch(()=>{});}
  }
  if(['diagnostic','pick','bind'].includes(m.type)){
    const tabs=await chrome.tabs.query({active:true,lastFocusedWindow:true});const tab=tabs[0];if(!tab||!siteFor(tab.url))throw new Error('対象フリマサイトを開いて拡張機能のアイコンから操作してください');
    if(m.type==='diagnostic')return content(tab.id,'diagnostic');
    if(m.type==='pick'){const result=await content(tab.id,'pick');if(result.cancelled)throw new Error('名前の紐付けが中止または時間切れになりました');const s=await getSettings();const a=s.accounts.find(x=>x.id===m.id);if(!a||siteFor(tab.url)!==a.site)throw new Error('選択アカウントとサイトが一致しません');if(a.site==='rakuma'){
      if(new URL(tab.url).origin!=='https://fril.jp'||new URL(tab.url).pathname!=='/mypage'||!/^.{1,100}さんのマイページ$/.test(result.identity.text))throw new Error('ラクマではマイページの「自分の名前さんのマイページ」を選んでください');
      result.identity.pageUrl='https://fril.jp/mypage';
    }
    a.identity=result.identity;await STORE.set({settings:s});await log('info','アカウント名を紐付けました',{account:a.label});await diagnosticReport();return {registered:true};}
    const s=await getSettings(),a=s.accounts.find(x=>x.id===m.id);if(!a||siteFor(tab.url)!==a.site||!a.identity)throw new Error('先にログイン中アカウント名を紐付けてください');
    const list=await content(tab.id,'list',{account:a,recipe:s.recipes[a.site]||{}});if(list.auth)throw new Error(list.auth);a.listUrl=tab.url;a.enabled=true;validateSettings(s);await STORE.set({settings:s});await log('info','購入一覧を登録しました',{account:a.label});await diagnosticReport();return {registered:true};
  }
  if(m.type==='export'){const {settings,events=[],lastRun,scheduledRuns={},authProblem=null,authRecoveryAttempt=null,outbox=[],pages=[],job,session,diagnosticInstance,lastReloadRequest,trackingAccess,trackingAccessHistory=[]}=await STORE.get(['settings','events','lastRun','scheduledRuns','authProblem','authRecoveryAttempt','outbox','pages','job','session','diagnosticInstance','lastReloadRequest','trackingAccess','trackingAccessHistory']);const profileId=diagnosticInstance||crypto.randomUUID();if(!diagnosticInstance)await STORE.set({diagnosticInstance:profileId});return {authProblem,authRecoveryAttempt,trackingAccess:trackingAccess||null,trackingAccessHistory,reloadRequest:lastReloadRequest||null,loadedBuild:LOADED_BUILD,version:chrome.runtime.getManifest().version,exportedAt:new Date().toISOString(),profileId,connected:!!session&&!authProblem,settings,events,lastRun,scheduledRuns,pages,job:job?{kind:job.kind,stage:job.stage,accountIndex:job.accountIndex,index:job.index,counts:job.counts}:null,sampling:{listPagesPerAccount:3,transactionsPerAccount:3},unsentTaskCount:outbox.length};}
  throw new Error('未知の操作です');
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  // サイトのcontent scriptから認証・設定・登録操作を要求できない。
  if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  if(m.type==='launchSites'&&sender.url!==chrome.runtime.getURL('launch.html'))return false;
  uiMessage(m).then(value=>respond({ok:true,value}),async e=>{if(['start','pick','bind','diagnostic','registerRakuma','registerSite'].includes(m.type))await log('error','登録・画面確認: '+e.message,{operation:m.type}).catch(()=>{});if(m.type==='start')await diagnosticReport();respond({ok:false,error:e.message});});return true;
});
chrome.runtime.onInstalled.addListener(()=>void initialize());
chrome.runtime.onStartup.addListener(()=>void initialize().then(resumeLauncherRecovery).then(due).then(step).catch(e=>log('error',e.message)));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='fm:update'){void processDesktopLaunchRequest().then(()=>checkPackageUpdate({runtime:chrome.runtime,storage:STORE,fetchFile:fetch,busy:()=>busy||sellerBusy,record:log})).catch(e=>log('error','更新確認: '+e.message));return;}if(a.name.startsWith('fm:'))void (async()=>{if(initializationPending)await initialization.catch(()=>{});if(a.name!=='fm:pulse')await schedule(a.name);await runPendingDiagnostic();if(!busy&&await recoverConnection())await applyProductionPlan();await resumeLauncherRecovery();await repairImportedTitles();await retryYahooTrackingRepair();await retryRakumaRepair();await due();await step();await runSellerWork();})().catch(e=>log('error',e.message));});
void initialize().catch(e=>log('error',e.message));

async function retryRakumaRepair(){
 const request='2026-10-08-rakuma-ids-v1';const {job,diagnosticInstance,lastRakumaRepair}=await STORE.get(['job','diagnosticInstance','lastRakumaRepair']);
 if(busy||job||lastRakumaRepair===request||diagnosticInstance!=='ba92b386-e0bc-48be-b3b6-ca9550fa1a2d')return;
 const s=await getSettings();if(!s.purchaseImportEnabled||s.mode!=='tracking'||!s.accounts.some(a=>a.enabled&&a.site==='rakuma'))return;
 await start('purchases',true);const state=await STORE.get('job');state.job.accounts=state.job.accounts.filter(a=>a.site==='rakuma');state.job.pageUrl=state.job.accounts[0].listUrl;await STORE.set({job:state.job,lastRakumaRepair:request});
 await log('info','ラクマの商品ID修正を確認するため、このアカウントだけ一度再取得します');
 const repairId=state.job.id;for(let n=0;n<50;n++){const current=await STORE.get('job');if(current.job?.id!==repairId||busy)break;await step();await wait(500);}
}
async function retryYahooTrackingRepair(){
 const request='2026-10-09-yahoo-redirect-v5';const {job,diagnosticInstance,lastYahooTrackingRepair}=await STORE.get(['job','diagnosticInstance','lastYahooTrackingRepair']);
 if(busy||job||lastYahooTrackingRepair===request||diagnosticInstance!=='ba92b386-e0bc-48be-b3b6-ca9550fa1a2d')return;
 const s=await getSettings();if(s.mode!=='tracking'||s.trackingPolicy!=='inventory-first'||!s.accounts.some(a=>a.enabled&&a.id==='auctions-1'))return;
 await start('tracking',true);const state=await STORE.get('job');state.job.accounts=state.job.accounts.filter(a=>a.id==='auctions-1');state.job.pageUrl=state.job.accounts[0].listUrl;await STORE.set({job:state.job,lastYahooTrackingRepair:request});
 await log('info','ヤフオクの正常な画面移動の修正を確認するため、ヤフオク1の追跡番号だけ一度再確認します');
 const repairId=state.job.id;for(let n=0;n<50;n++){const current=await STORE.get('job');if(current.job?.id!==repairId||busy)break;await step();await wait(500);}
}

async function repairImportedTitles(){
 const request='2026-10-13-yahoo-title-v1';const {job,diagnosticInstance,lastPurchaseTitleRepair}=await STORE.get(['job','diagnosticInstance','lastPurchaseTitleRepair']);
 if(busy||job||lastPurchaseTitleRepair===request||diagnosticInstance!=='ba92b386-e0bc-48be-b3b6-ca9550fa1a2d')return;
 const settings=await getSettings(),a=settings.accounts.find(a=>a.enabled&&a.id==='auctions-1');if(!a||settings.mode!=='tracking')return;
 busy=true;const j={kind:'diagnostic',stage:'list',tabId:null};
 try{
  if(await rpc('is_admin')!==true)throw Error('管理者連携を確認できません');
  await navigate(j,prepareAccount(a),a.listUrl);
  const data=await content(j.tabId,'list',{account:prepareAccount(a),recipe:{purchaseImport:true,includeCompleted:true,referenceDay:jstDay()}});if(data.auth)throw Error(data.auth);
  const expected=['q1246533097','f1246665249'];const rows=expected.map(id=>data.purchaseRows?.find(r=>r.marketplace_item_id===id));
  if(rows.some(r=>!r?.title||/^(?:新しい|未読の)?取引メッセージがあります$/.test(r.title)))throw Error('修正対象の商品名を購入一覧で確認できません');
  const result=await rpc('extension_sync_purchase_drafts',{p_marketplace:'ヤフオク',p_account_label:a.label,p_purchases:rows.map(r=>({marketplace_item_id:r.marketplace_item_id,marketplace_url:r.marketplace_url,title:r.title}))});
  await STORE.set({lastPurchaseTitleRepair:request,purchaseTitleRepairResult:{at:new Date().toISOString(),request,rows:rows.map(r=>({itemId:r.marketplace_item_id,title:r.title})),result}});
  await log('info','仕入れリストの商品名を修正しました',{refreshed:result.refreshed});
 }catch(e){await STORE.set({lastPurchaseTitleRepair:request,purchaseTitleRepairResult:{at:new Date().toISOString(),request,error:e.message}});await log('error','仕入れリスト商品名修正: '+e.message);}
 finally{if(j.borrowedTab)await restoreSiteTab(chrome.tabs,j.borrowedTab).catch(()=>{});await STORE.set({job:null});busy=false;}
}

async function launchPending(){const url=chrome.runtime.getURL('launch.html');return (await chrome.tabs.query({})).some(t=>(t.url===url||t.pendingUrl===url)&&!readyLaunchTabs.has(t.id));}
async function launchFromIcon(m){
 const tab=await chrome.tabs.get(m.launchTabId);if(tab.url!==chrome.runtime.getURL('launch.html'))throw Error('起動画面を確認できません');
 const s=await getSettings();const result=await openLauncherSites(chrome.tabs,s,tab.windowId);readyLaunchTabs.add(tab.id);
 const state=await STORE.get(['lastRun','scheduledRuns','events','launcherRecoveryMarks','launcherRecoveryQueue','session','authProblem']);
 const recovery=missingTabRecovery(s,state,state.events||[],state.launcherRecoveryMarks||{});
 const queue=[...(state.launcherRecoveryQueue||[]).filter(q=>q.day===jstDay()),...recovery.requests];
 const status={at:new Date().toISOString(),...result,recoveryAccounts:recovery.requests.reduce((n,r)=>n+r.accounts.length,0),connected:!!state.session?.access_token&&!state.authProblem};
 await STORE.set({launcherRecoveryQueue:queue,launcherRecoveryMarks:recovery.marks,launcherStatus:status});
 void resumeLauncherRecovery().then(()=>due()).then(()=>step()).catch(e=>log('error','起動後の確認: '+e.message));return status;
}
async function resumeLauncherRecovery(){
 if(busy||dailyStarting||await launchPending())return;const state=await STORE.get(['job','launcherRecoveryQueue']);if(state.job)return;
 const queue=(state.launcherRecoveryQueue||[]).filter(r=>r.day===jstDay());if(!queue.length)return;
 const s=await getSettings();if(s.mode!=='tracking')return;const r=queue[0];if(!['purchases','tracking'].includes(r.kind))throw Error('起動後の再確認種別が不正です');
 const accounts=s.accounts.filter(a=>a.enabled&&r.accounts.includes(a.id));if(!accounts.length){await STORE.set({launcherRecoveryQueue:queue.slice(1)});return;}
 if(dailyStarting)return;dailyStarting=true;try{if(!await recoverConnection())return;await start(r.kind,true);const {job}=await STORE.get('job');job.accounts=accounts.map(prepareAccount);job.pageUrl=job.accounts[0].listUrl;await STORE.set({job,launcherRecoveryQueue:queue.slice(1)});await log('info','起動アイコンから、既存タブ不足で停止したアカウントだけ再確認します',{kind:r.kind,accounts:accounts.map(a=>a.label)});}finally{dailyStarting=false;}
}

function processDesktopLaunchRequest(){const task=launcherChain.catch(()=>{}).then(prepareDesktopLaunchRequest);launcherChain=task;return task;}
async function prepareDesktopLaunchRequest(){
 let request;try{const r=await fetch(chrome.runtime.getURL('desktop-launch-request.json'),{cache:'no-store'});if(!r.ok)return;request=await r.json();}catch{return;}
 const state=await STORE.get(['diagnosticInstance','lastDesktopLaunchRequest']);
 if(!PRODUCTION_PLAN.profiles[state.diagnosticInstance]||!desktopRequestApplies(request,state.diagnosticInstance,state.lastDesktopLaunchRequest))return;
 const s=await getSettings(),result=await openLauncherSites(chrome.tabs,s);
 const records=await STORE.get(['lastRun','scheduledRuns','events','launcherRecoveryMarks','launcherRecoveryQueue','session','authProblem']);
 const recovery=missingTabRecovery(s,records,records.events||[],records.launcherRecoveryMarks||{});
 const status={at:new Date().toISOString(),source:'desktop-request',...result,recoveryAccounts:recovery.requests.reduce((n,r)=>n+r.accounts.length,0),connected:!!records.session?.access_token&&!records.authProblem};
 await STORE.set({lastDesktopLaunchRequest:request.id,launcherStatus:status,launcherRecoveryMarks:recovery.marks,launcherRecoveryQueue:[...(records.launcherRecoveryQueue||[]).filter(q=>q.day===jstDay()),...recovery.requests]});
 await log('info','デスクトップの起動要求でフリマサイトを準備しました',{created:result.created,reused:result.reused});
}

async function runSellerWork(){
 if(sellerBusy||busy||await launchPending())return;
 const records=await STORE.get(['session','authProblem','job','diagnosticInstance','lastRun','scheduledRuns','sellerDailyAttempt','sellerHourlyAttempt','sellerObservationCache','sellerSaleBackfills','sellerBarrierDay','sellerBarrierError','sellerQueueErrorDay']);
 if(records.job||records.authProblem||!records.session?.access_token||!PRODUCTION_PLAN.profiles[records.diagnosticInstance])return;
 const settings=await getSettings();if(settings.mode==='diagnostic')return;
 sellerBusy=true;try{
  const dependencies={settings,storage:STORE,rpc,log,openSession:account=>openSellerSession(prepareAccount(account),{tabs:chrome.tabs,scripting:chrome.scripting,windows:chrome.windows,identity:(tabId,account)=>content(tabId,'identity',{account})})};
  if(await runSellerReadOnlyInspection({...dependencies,profileId:records.diagnosticInstance,fetchRequest:async()=>{try{const response=await fetch(chrome.runtime.getURL('seller-inspection-request.json'),{cache:'no-store'});return response.ok?await response.json():null;}catch{return null;}}}))return;
  if(await runSellerSaleRepair({...dependencies,records,day:jstDay(),profileId:records.diagnosticInstance,fetchRequest:async()=>{try{const response=await fetch(chrome.runtime.getURL('seller-inspection-request.json'),{cache:'no-store'});return response.ok?await response.json():null;}catch{return null;}}}))return;
  if(records.sellerQueueErrorDay!==jstDay())try{await supplierQueuedOperations({settings,rpc,tabs:chrome.tabs,content,log});await sellerQueuedOperations(dependencies);}catch(error){await STORE.set({sellerQueueErrorDay:jstDay()});await log('error','販売操作の取得を停止しました。自動再試行はしません：'+error.message);}
  await sellerDaily({...dependencies,records,day:jstDay(),profileId:records.diagnosticInstance});
  const hourlyRecords={...records,...await STORE.get(['job','authProblem','sellerDailyAttempt','sellerHourlyAttempt','sellerObservationCache'])};
  await sellerDaily({...dependencies,records:hourlyRecords,day:jstDay(),profileId:records.diagnosticInstance,hourly:true});
 }finally{sellerBusy=false;}
}
