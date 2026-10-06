import {SITES,API,PUBLIC_KEY,assertSiteUrl,siteFor,eligible,jstDay,dueTime,nextTime,settingsDefault,validateSettings} from './core.js';
import {rpc,connectSession} from './api.js';
const STORE=chrome.storage.local;
let busy=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function getSettings(){const {settings}=await STORE.get('settings');return settings||settingsDefault();}
async function log(kind,text,extra={}){const {events=[]}=await STORE.get('events');events.unshift({at:new Date().toISOString(),kind,text,...extra});await STORE.set({events:events.slice(0,200)});await chrome.action.setBadgeText({text:kind==='error'?'!':''});}
async function schedule(){const s=await getSettings();for(const [kind,hour] of [['tracking',s.trackingHour],['receipt',s.receiptHour],['purchases',3]])await chrome.alarms.create('fm:'+kind,{when:nextTime(hour)});await chrome.alarms.create('fm:pulse',{periodInMinutes:1});}
async function initialize(){await STORE.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});if(!(await STORE.get('settings')).settings)await STORE.set({settings:settingsDefault()});await schedule();const version=chrome.runtime.getManifest().version;const s=await getSettings();if(s.mode==='diagnostic'&&s.accounts.some(a=>a.enabled)&&(await STORE.get('lastDiagnosticVersion')).lastDiagnosticVersion!==version){await STORE.set({lastDiagnosticVersion:version});await diagnosticReport();}}
async function saveSettings(s){validateSettings(s);const {job}=await STORE.get('job');if(job)throw new Error('巡回中は設定を変更できません。先に停止してください');
  if(s.mode==='full'&&!s.migrationConfirmed)throw new Error('既存Codex処理の停止と評価画面の検証後に切り替えてください');
  if(s.mode!=='diagnostic')for(const a of s.accounts.filter(a=>a.enabled)){const r=s.recipes[a.site];if(!r?.verified)throw new Error(a.label+'の実画面検証が未完了です');if(s.mode==='full'&&!r.receiptVerified)throw new Error(a.label+'の評価画面検証が未完了です');}
  await STORE.set({settings:s});await schedule();return {saved:true};}
async function content(tabId,type,args={}){
  const account=args.account;
  if(account?.identity?.pageUrl&&type==='scrollList'){
    const target=await chrome.tabs.get(tabId);assertSiteUrl(account.site,target.url);
    if(target.url!==account.listUrl)throw new Error('登録済みの購入一覧ページから移動したためスクロールを停止しました');
    args={...args,account:{...account,_identityConfirmed:true}};
  }else if(account?.identity?.pageUrl&&type==='purchaseDetail'&&account._identityConfirmed===true){
    const target=await chrome.tabs.get(tabId);assertSiteUrl(account.site,target.url);
  }else if(account?.identity?.pageUrl&&type!=='identity'){
    assertSiteUrl(account.site,account.identity.pageUrl);if(!['rakuma','mercari','flea','auctions'].includes(account.site))throw new Error('アカウント確認ページが不正です');
    if(!['list','detail','preflight','submit','success','messageDetail','sendMessage','purchaseDetail'].includes(type))throw new Error('アカウント確認の処理種別が不正です');
    const target=await chrome.tabs.get(tabId);assertSiteUrl(account.site,target.url);
    const checkTab=await chrome.tabs.create({url:account.identity.pageUrl,active:false});
    try{
      await loaded(checkTab.id,account.site);
      const confirmed=await content(checkTab.id,'identity',{account:{...account,_identityConfirmed:false}});
      if(confirmed.auth)throw new Error(confirmed.auth);
      if(confirmed.confirmed!==true)throw new Error('ログイン中アカウントを確認できません');
    }finally{await chrome.tabs.remove(checkTab.id).catch(()=>{});}
    args={...args,account:{...account,_identityConfirmed:true}};
  }
  let r;const message={type:'fm:'+type,...args};try{r=await chrome.tabs.sendMessage(tabId,message);}catch(e){
  // 導入前から開いていたページにはcontent scriptが未配置の場合がある。
  if(!/Receiving end does not exist|Could not establish connection/i.test(e.message||''))throw e;
  const tab=await chrome.tabs.get(tabId);if(!siteFor(tab.url))throw e;
  await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
  r=await chrome.tabs.sendMessage(tabId,message);
}if(!r?.ok)throw new Error(r?.error||'サイト読み取りスクリプトに接続できません');return r.value;}
async function loaded(tabId,site){const until=Date.now()+18000;while(Date.now()<until){const tab=await chrome.tabs.get(tabId);if(tab.status==='complete'){if(siteFor(tab.url)!==site)throw new Error('ログイン切れ: 対象サイト以外へ移動しました');await wait(700);return;}await wait(300);}throw new Error('ページの読み込みが時間切れになりました');}
async function navigate(job,account,url){assertSiteUrl(account.site,url);if(job.tabId){try{await chrome.tabs.get(job.tabId);}catch{job.tabId=null;}}
  if(job.tabId)await chrome.tabs.update(job.tabId,{url,active:false});else{job.tabId=(await chrome.tabs.create({url,active:false})).id;await STORE.set({job});}
  await loaded(job.tabId,account.site);
}
function taskArgs(account,status,kind,details,itemId=null){const label={tracking:'追跡番号照合',receipt:'受け取り評価'}[kind]||kind;return {p_marketplace:SITES[account.site].db[0],p_account_label:account.label,p_marketplace_item_id:itemId,p_site_tracking_no:null,p_confirmation_status:status,p_details:`処理種別=${label}; 拡張機能; ${details}`};}
async function task(account,status,kind,details,itemId=null){const args=taskArgs(account,status,kind,details,itemId);try{await rpc('reconcile_marketplace_tracking',args);}catch(e){const {outbox=[]}=await STORE.get('outbox');const key=account.id+':'+status+':'+(itemId||'');const filtered=outbox.filter(x=>x.key!==key);filtered.push({key,args});await STORE.set({outbox:filtered.slice(-200)});await log('error','ダッシュボードへ未送信: '+e.message,{account:account.label,status,itemId});}}
async function flushOutbox(){const {outbox=[]}=await STORE.get('outbox');if(!outbox.length)return;try{await rpc('reconcile_marketplace_tracking',outbox[0].args);await STORE.set({outbox:outbox.slice(1)});}catch{}}
function prepareAccount(a){const copy=structuredClone(a);if(copy.site==='auctions'&&copy.listUrl==='https://auctions.yahoo.co.jp/my/won'&&copy.identity)copy.identity.pageUrl=copy.listUrl;return copy;}
async function diagnosticReport(){if((await getSettings()).mode==='diagnostic')await chrome.tabs.create({url:chrome.runtime.getURL('report.html'),active:false}).catch(()=>{});}
async function capturePage(job,a,stage){if(job.settings.mode!=='diagnostic')return;try{const d=await content(job.tabId,'diagnostic');const {pages=[]}=await STORE.get('pages');pages.push({at:new Date().toISOString(),account:a.label,stage,...d});await STORE.set({pages:pages.slice(-60)});}catch{}}
async function start(kind,manual=false){if(!['tracking','receipt','messages','purchases'].includes(kind))throw new Error('処理種別が不正です');const {job}=await STORE.get('job');if(job)throw new Error('別の巡回を実行中です');const s=await getSettings();const accounts=s.accounts.filter(a=>a.enabled).map(prepareAccount);if(!accounts.length)throw new Error('このChromeプロファイルのアカウントを登録してください');
  if(kind==='receipt'&&s.mode!=='full')throw new Error('受け取り評価は実画面検証と切り替え後に有効になります');
  // 診断モードにはSupabaseの読み取り照合も含むが、登録・評価送信は行わない。
  if(await rpc('is_admin')!==true)throw new Error('管理アプリとの連携を確認してください');
  const marketplaces=[...new Set(accounts.flatMap(a=>SITES[a.site].db))];
  const outbox=kind==='messages'?await rpc('extension_marketplace_message_queue',{p_marketplaces:marketplaces}):[];
  const syncRequests=kind==='messages'?await rpc('extension_marketplace_message_sync_queue',{p_marketplaces:marketplaces}):[];
  if(kind==='messages'&&!outbox.length&&!syncRequests.length)throw new Error('確認または送信する取引メッセージはありません');
  const targets=[...new Map([...syncRequests.map(entry=>({...entry,source:'sync'})),...outbox.map(entry=>({...entry,source:'send'}))].map(entry=>[entry.marketplace+':'+entry.marketplace_item_id,entry])).values()];
  const targetAccounts=kind==='messages'?accounts.filter(a=>targets.some(t=>SITES[a.site].db.includes(t.marketplace))):accounts;
  if(!targetAccounts.length)throw new Error('取引メッセージの対象サイトに対応するログイン済みアカウントがありません');
  await STORE.set({job:{id:crypto.randomUUID(),kind,manual,day:jstDay(),accountIndex:0,stage:'list',pageUrl:targetAccounts[0].listUrl,seenPages:[],urls:[],index:0,tabId:null,counts:{checked:0,updated:0,rated:0,imported:0,skipped:0,errors:0},settings:s,accounts:targetAccounts,outbox,syncRequests,targets}});
  await log('info',kind==='tracking'?'追跡番号の巡回を開始':kind==='messages'?'取引メッセージの同期を開始':kind==='purchases'?'購入履歴の取り込みを開始':'受け取り評価の巡回を開始');return {started:true};}
async function finish(job){if(job.tabId)await chrome.tabs.remove(job.tabId).catch(()=>{});const {lastRun={}}=await STORE.get('lastRun');lastRun[job.kind]={day:job.day,at:new Date().toISOString(),counts:job.counts};await STORE.set({lastRun,job:null});await log('info','巡回終了',job.counts);await diagnosticReport();}
async function nextAccount(job){if(job.tabId)await chrome.tabs.remove(job.tabId).catch(()=>{});job.tabId=null;job.accountIndex++;job.urls=[];job.index=0;job.seenPages=[];job.stage='list';job.pageUrl=job.accounts[job.accountIndex]?.listUrl;if(job.accountIndex>=job.accounts.length){if(job.kind==='messages'){for(const entry of job.outbox||[])await rpc('extension_finish_marketplace_message',{p_id:entry.id,p_status:'failed',p_note:'登録された購入一覧で対象取引が見つかりません'}).catch(()=>{});for(const request of job.syncRequests||[]){const claimed=await rpc('extension_claim_marketplace_message_sync',{p_id:request.id,p_claimant:'not-found'}).catch(()=>false);if(claimed)await rpc('extension_finish_marketplace_message_sync',{p_id:request.id,p_status:'failed',p_note:'登録された購入一覧で対象取引が見つかりません'}).catch(()=>{});}}return finish(job);}await STORE.set({job});}
function receiptArgs(a,itemId,action,token=null,details=null){return {p_action:action,p_marketplace:SITES[a.site].db[0],p_item_id:itemId,p_account_label:a.label,p_token:token,p_details:details};}
async function recoverSend(job,a){
  const p=job.pendingReceipt;
  if(p){await rpc('marketplace_extension_receipt',receiptArgs(a,p.itemId,'unknown',p.token,'Chrome停止等により送信結果が未確認')).catch(()=>{});await task(a,'評価結果要確認','受け取り評価','送信済みか判定できないため自動再送を停止しています',p.itemId);}
  delete job.pendingReceipt;job.stage='detail';job.index++;job.counts.errors++;await STORE.set({job});
}
async function step(){if(busy)return;busy=true;try{
  let {job}=await STORE.get('job');if(!job){await flushOutbox();return;}
  const a=prepareAccount(job.accounts[job.accountIndex]),r=job.settings.recipes[a.site]||{};
  if(job.stage==='sending'){await recoverSend(job,a);return;}
  try{
    if(job.stage==='list'){
      if(job.seenPages.includes(job.pageUrl)||job.seenPages.length>=20)throw new Error('取引一覧のページ数または巡回重複を確認してください');
      const listRecipe=['messages','purchases'].includes(job.kind)?{...r,includeCompleted:true}:r;
      await navigate(job,a,job.pageUrl);await capturePage(job,a,'list');const data=await content(job.tabId,'list',{account:a,recipe:listRecipe});if(data.auth)throw new Error(data.auth);
      if(job.kind==='purchases'){
        const seenIds=new Set();let imported=0,checked=0,scrollSteps=0,stalledScrolls=0,previousScrollTop=data.scrollTop??0,stopReason='ページ末尾';let pageData=data;
        for(let stepIndex=0;;stepIndex++){
          if(stepIndex>0){pageData=await content(job.tabId,'scrollList',{account:a,recipe:listRecipe});if(pageData.auth)throw new Error(pageData.auth);scrollSteps++;}
          const fresh=[];
          for(const purchase of pageData.purchases||[]){
            if(!purchase.marketplace_item_id||seenIds.has(purchase.marketplace_item_id))continue;
            seenIds.add(purchase.marketplace_item_id);fresh.push(purchase);
          }
          for(const purchase of fresh){
            checked++;
            const marketplace=SITES[a.site].db[0];
            const existing=await rpc('extension_probe_purchase_item',{p_marketplace:marketplace,p_marketplace_item_id:purchase.marketplace_item_id});
            if(existing?.matched){stopReason='商品IDが在庫と一致';break;}
            let enriched=purchase;
            let detailTab=null;
            try{
              const detailUrl=purchase.detail_url||purchase.marketplace_url;
              assertSiteUrl(a.site,detailUrl);
              detailTab=(await chrome.tabs.create({url:detailUrl,active:false})).id;
              await loaded(detailTab,a.site);
              const detail=await content(detailTab,'purchaseDetail',{account:{...a,_identityConfirmed:true},recipe:listRecipe,fallback:purchase});
              if(detail.auth)throw new Error(detail.auth);
              enriched=detail;
            }catch(error){
              await log('error','購入商品の詳細を読み取れませんでした。購入一覧の情報で下書き登録します: '+error.message,{account:a.label,itemId:purchase.marketplace_item_id});
            }finally{if(detailTab)await chrome.tabs.remove(detailTab).catch(()=>{});}
            if(enriched.marketplace_item_id!==purchase.marketplace_item_id){
              const detailMatch=await rpc('extension_probe_purchase_item',{p_marketplace:marketplace,p_marketplace_item_id:enriched.marketplace_item_id});
              if(detailMatch?.matched){stopReason='商品IDが在庫と一致';break;}
            }
            const result=await rpc('extension_sync_purchase_drafts',{p_marketplace:marketplace,p_account_label:a.label,p_purchases:[enriched],p_stop_on_match:true});
            imported+=Number(result?.inserted)||0;
            if(Array.isArray(result?.matched_item_ids)&&result.matched_item_ids.length){stopReason='同期直前に商品IDが在庫と一致';break;}
          }
          if(stopReason!=='ページ末尾')break;
          if(!pageData.hasMore)break;
          const moved=Number(pageData.scrollTop??0)>previousScrollTop||fresh.length>0;
          stalledScrolls=moved?0:stalledScrolls+1;previousScrollTop=Number(pageData.scrollTop??previousScrollTop);
          if(stalledScrolls>=2){stopReason='同じ一覧ページでスクロール進行が止まった';break;}
        }
        job.counts.imported+=imported;job.counts.checked+=checked;
        if(imported||checked)await log('info',`購入履歴を確認: 新規 ${imported}件 / 確認 ${checked}件 / スクロール ${scrollSteps}回 / 停止=${stopReason}`,{account:a.label});
        job.seenPages.push(job.pageUrl);
        // Start at the top without scrolling. A detail page is opened only for a non-matching ID; the registered listing page is the only page scrolled, and a next listing page is never opened.
        await nextAccount(job);return;
      }
      if(job.kind==='messages'){
        const wanted=(job.targets||[]).filter(t=>SITES[a.site].db.includes(t.marketplace));const wantedIds=new Set(wanted.map(t=>t.marketplace_item_id));
        const pageTargets=(data.messageTargets||[]).filter(t=>wantedIds.has(t.itemId));const marketplaceKey=SITES[a.site].db[0];
        job.urls=[...new Set([...job.urls,...pageTargets.map(t=>t.url)])];job.foundTargetIds=[...new Set([...(job.foundTargetIds||[]),...pageTargets.map(t=>marketplaceKey+':'+t.itemId)])];
        const found=new Set(job.foundTargetIds);
        for(const request of job.syncRequests||[]){if(SITES[a.site].db.includes(request.marketplace)&&!found.has(request.marketplace+':'+request.marketplace_item_id)){const claimed=await rpc('extension_claim_marketplace_message_sync',{p_id:request.id,p_claimant:'not-on-current-list'}).catch(()=>false);if(claimed)await rpc('extension_finish_marketplace_message_sync',{p_id:request.id,p_status:'failed',p_note:'登録された購入一覧の現在ページに対象取引がありません。ページ移動は行いません。'}).catch(()=>{});}}
        for(const entry of job.outbox||[]){if(SITES[a.site].db.includes(entry.marketplace)&&!found.has(entry.marketplace+':'+entry.marketplace_item_id)){await rpc('extension_finish_marketplace_message',{p_id:entry.id,p_status:'failed',p_note:'登録された購入一覧の現在ページに対象取引がありません。ページ移動は行いません。'}).catch(()=>{});job.outbox=job.outbox.filter(x=>x.id!==entry.id);}}
        job.syncRequests=(job.syncRequests||[]).filter(request=>found.has(request.marketplace+':'+request.marketplace_item_id));job.targets=(job.targets||[]).filter(target=>found.has(target.marketplace+':'+target.marketplace_item_id));
        job.stage='detail';await STORE.set({job});return;
      }
      if(job.settings.mode==='diagnostic'&&!data.links.length)await log('info','取引リンク0件。未完了取引がないとは未確認です',{account:a.label});
      job.seenPages.push(job.pageUrl);job.urls=[...new Set([...job.urls,...data.links])];if(job.urls.length>500)throw new Error('取引数が上限を超えました');
      if(job.settings.mode==='diagnostic'){job.urls=job.urls.slice(0,3);if(job.seenPages.length>=3)data.nextUrl=null;}
      if(data.nextUrl)job.pageUrl=data.nextUrl;else job.stage='detail';await STORE.set({job});return;
    }
    if(job.index>=job.urls.length){await nextAccount(job);return;}
    if(job.kind==='messages'){
      const targetUrl=job.urls[job.index];await navigate(job,a,targetUrl);
      const tx=await content(job.tabId,'messageDetail',{account:a,recipe:r});if(tx.auth)throw new Error(tx.auth);
      const target=(job.targets||[]).find(entry=>SITES[a.site].db.includes(entry.marketplace)&&entry.marketplace_item_id===tx.itemId);
      if(!target)throw new Error('表示中の取引IDが同期対象と一致しません');
      const syncRequest=(job.syncRequests||[]).find(entry=>entry.marketplace===target.marketplace&&entry.marketplace_item_id===tx.itemId);
      if(syncRequest){const claimed=await rpc('extension_claim_marketplace_message_sync',{p_id:syncRequest.id,p_claimant:a.id+':'+a.label});if(claimed){try{await rpc('extension_sync_marketplace_messages',{p_marketplace:target.marketplace,p_item_id:tx.itemId,p_account_label:a.label,p_messages:tx.messages||[]});await rpc('extension_finish_marketplace_message_sync',{p_id:syncRequest.id,p_status:'completed',p_note:'アプリ送信以降の相手メッセージを照合しました'});}catch(error){await rpc('extension_finish_marketplace_message_sync',{p_id:syncRequest.id,p_status:'failed',p_note:error.message}).catch(()=>{});throw error;}}}
      const queued=(job.outbox||[]).find(entry=>entry.marketplace===target.marketplace&&entry.marketplace_item_id===tx.itemId);
      if(queued){const claimed=await rpc('extension_claim_marketplace_message',{p_id:queued.id,p_claimant:a.id+':'+a.label});job.outbox=job.outbox.filter(entry=>entry.id!==queued.id);if(claimed){let clicked=false;try{
        const sent=await content(job.tabId,'sendMessage',{account:a,recipe:r,itemId:tx.itemId,body:queued.body});clicked=sent.clicked===true;await loaded(job.tabId,a.site);await wait(1400);
        const updated=await content(job.tabId,'messageDetail',{account:a,recipe:r});const echoed=(updated.messages||[]).some(message=>message.body===queued.body&&message.author_role==='self');
        await rpc('extension_finish_marketplace_message',{p_id:queued.id,p_status:echoed?'sent':'uncertain',p_note:echoed?'取引画面に送信済みの文面を確認しました':'送信後の表示を確認できません。取引画面を確認してください'});
        if(echoed)await rpc('extension_sync_marketplace_messages',{p_marketplace:target.marketplace,p_item_id:tx.itemId,p_account_label:a.label,p_messages:updated.messages||[]});
        await log(echoed?'info':'error',echoed?'取引メッセージを送信しました':'送信結果を要確認',{account:a.label,itemId:tx.itemId});
      }catch(error){await rpc('extension_finish_marketplace_message',{p_id:queued.id,p_status:clicked?'uncertain':'failed',p_note:clicked?'送信ボタン押下後の確認でエラー: '+error.message:error.message}).catch(()=>{});await log('error','取引メッセージ送信: '+error.message,{account:a.label,itemId:tx.itemId});}}}
      job.counts.checked++;job.index++;await STORE.set({job});return;
    }
    await navigate(job,a,job.urls[job.index]);await capturePage(job,a,'detail');const tx=await content(job.tabId,'detail',{account:a,recipe:r});if(tx.auth)throw new Error(tx.auth);job.counts.checked++;
    if(tx.role!=='buyer'||tx.state!=='pending'){job.counts.skipped++;if(tx.role==='unknown'||tx.state==='unknown'){await log('error','購入者・取引状態を判定できません',{account:a.label,itemId:tx.itemId});if(job.settings.mode!=='diagnostic')await task(a,'画面確認待ち',job.kind,'購入者側の未完了取引か判断できません',tx.itemId);}job.index++;await STORE.set({job});return;}
    const match=await rpc('marketplace_extension_probe',{p_marketplace:SITES[a.site].db[0],p_item_id:tx.itemId});
    if(job.kind==='tracking'){
      if(job.settings.mode==='diagnostic'||!r.verified){await log('info','診断: 更新せず照合',{account:a.label,itemId:tx.itemId,count:match.count,trackingNo:tx.trackingNo,sku:match.items.map(x=>x.sku)});}
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
    job.counts.errors++;await log('error',e.message,{account:a.label});
    if(job.stage==='sending'){await recoverSend(job,a);return;}
    if(job.settings.mode!=='diagnostic'){const status=/追加承認待ち/.test(e.message)?'追加承認待ち':/ログイン切れ/.test(e.message)?'ログイン切れ':/アカウント/.test(e.message)?'アカウント未確認':'画面確認待ち';await task(a,status,job.kind,e.message);}
    // 認証・画面異常があるアカウントはこの回の巡回を停止。利用者用にタブを残す。
    job.tabId=null;await nextAccount(job);
  }
}finally{busy=false;}}
async function due(){const s=await getSettings();const {lastRun={},job}=await STORE.get(['lastRun','job']);if(job)return;
  try{
    const sites=[...new Set(s.accounts.filter(a=>a.enabled).flatMap(a=>SITES[a.site].db))];
    if(sites.length){const [sendQueue,syncQueue]=await Promise.all([rpc('extension_marketplace_message_queue',{p_marketplaces:sites}),rpc('extension_marketplace_message_sync_queue',{p_marketplaces:sites})]);if(sendQueue.length||syncQueue.length){await start('messages');return;}}
  }catch(e){await log('error','メッセージ送信依頼の確認: '+e.message);}
  const purchaseDue=dueTime(3);if(Date.now()>=purchaseDue&&Date.now()-purchaseDue<12*3600000&&lastRun.purchases?.day!==jstDay()){await start('purchases');return;}
  if(s.mode==='diagnostic')return;
  for(const [kind,hour] of [['tracking',s.trackingHour],['receipt',s.receiptHour]]){if(kind==='receipt'&&s.mode!=='full')continue;const t=dueTime(hour);if(Date.now()>=t&&Date.now()-t<12*3600000&&lastRun[kind]?.day!==jstDay()){await start(kind);break;}}
}
async function uiMessage(m){
  if(m.type==='state'){const {session,...state}=await STORE.get(['settings','events','job','lastRun','outbox','session']);return {...state,job:state.job?{kind:state.job.kind,stage:state.job.stage,counts:state.job.counts,account:state.job.accounts[state.job.accountIndex]?.label}:null,connected:!!session?.access_token};}
  if(m.type==='clearAccount'){
    if((await STORE.get('job')).job)throw new Error('巡回中は登録を削除できません。先に巡回を停止してください');
    const s=await getSettings(),a=s.accounts.find(x=>x.id===m.id);if(!a)throw new Error('対象アカウントが見つかりません');
    a.enabled=false;delete a.identity;delete a.listUrl;delete a._identityConfirmed;
    await STORE.set({settings:s});await log('info','名前と購入一覧の登録を削除しました',{account:a.label});return {cleared:true,label:a.label};
  }
  if(m.type==='save')return saveSettings(m.settings);
  if(m.type==='start'){const result=await start(m.kind,true);void step();return result;}
  if(m.type==='stop'){if(busy)throw new Error('処理中です。現在の1件が終わってから停止してください');const {job}=await STORE.get('job');if(job?.pendingReceipt)await recoverSend(job,job.accounts[job.accountIndex]);if(job)await finish(job);return {stopped:true};}
  if(m.type==='disconnect'){if((await STORE.get('job')).job)throw new Error('先に巡回を停止してください');await STORE.remove('session');return {disconnected:true};}
  if(m.type==='connect'){
    const tabs=await chrome.tabs.query({url:'https://bussan-admin.vercel.app/*'});
    if(!tabs.length){await chrome.tabs.create({url:'https://bussan-admin.vercel.app/'});throw new Error('管理アプリを開きました。ログイン後、もう一度「連携」を押してください');}
    const [{result:existing}]=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},func:()=>{const raw=localStorage.getItem('sb-xgoppuqoqeppckyunnvx-auth-token');try{const s=JSON.parse(raw);return s?{access_token:s.access_token,email:s.user?.email}:null;}catch{return null;}}});
    if(!existing?.access_token||!existing.email)throw new Error('管理アプリにログインしてから再度連携してください');
    if(await rpc('is_admin',{},existing.access_token)!==true)throw new Error('管理者アカウントでの連携が必要です');
    // 既存アプリのrefresh tokenを共有せず、アプリの既存ログイン処理で独立したセッションを作る。
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tabs[0].id},args:[API,PUBLIC_KEY,existing.email],func:async(api,key,email)=>{
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
      const profile=await chrome.tabs.create({url:'https://fril.jp/mypage',active:false});created.push(profile.id);await loaded(profile.id,'rakuma');
      const result=await content(profile.id,'rakumaIdentity');a.identity=result.identity;
      if(!a.identity?.selector||!/^.{1,100}さんのマイページ$/.test(a.identity.text||'')||a.identity.pageUrl!=='https://fril.jp/mypage')throw new Error('ラクマのアカウント名を確認できません');
      let purchase=active;
      if(new URL(active.url).pathname!=='/buy'){purchase=await chrome.tabs.create({url:'https://fril.jp/buy',active:false});created.push(purchase.id);await loaded(purchase.id,'rakuma');}
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
  if(m.type==='export'){const {settings,events=[],lastRun,outbox=[],pages=[],job,session,diagnosticInstance}=await STORE.get(['settings','events','lastRun','outbox','pages','job','session','diagnosticInstance']);const profileId=diagnosticInstance||crypto.randomUUID();if(!diagnosticInstance)await STORE.set({diagnosticInstance:profileId});return {version:chrome.runtime.getManifest().version,exportedAt:new Date().toISOString(),profileId,connected:!!session,settings,events,lastRun,pages,job:job?{kind:job.kind,stage:job.stage,accountIndex:job.accountIndex,index:job.index,counts:job.counts}:null,sampling:{listPagesPerAccount:3,transactionsPerAccount:3},unsentTaskCount:outbox.length};}
  throw new Error('未知の操作です');
}
chrome.runtime.onMessage.addListener((m,sender,respond)=>{
  // サイトのcontent scriptから認証・設定・登録操作を要求できない。
  if(sender.id!==chrome.runtime.id||!sender.url?.startsWith(chrome.runtime.getURL('')))return false;
  uiMessage(m).then(value=>respond({ok:true,value}),async e=>{if(['start','pick','bind','diagnostic','registerRakuma','registerSite'].includes(m.type))await log('error','登録・画面確認: '+e.message,{operation:m.type}).catch(()=>{});if(m.type==='start')await diagnosticReport();respond({ok:false,error:e.message});});return true;
});
chrome.runtime.onInstalled.addListener(()=>void initialize());
chrome.runtime.onStartup.addListener(()=>void initialize().then(due).then(step).catch(e=>log('error',e.message)));
chrome.alarms.onAlarm.addListener(a=>{if(a.name.startsWith('fm:'))void (async()=>{if(a.name!=='fm:pulse')await schedule();await due();await step();})().catch(e=>log('error',e.message));});
void initialize().catch(e=>log('error',e.message));
