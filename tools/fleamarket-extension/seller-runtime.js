import {readSellerStructure} from './seller-inspection.js';
import {sellerScheduleReady,sellerAccounts,sellerUrl,sellerTarget,readSellerPage,parseSellerSaleDetail} from './seller-sync.js';
import {borrowSiteTab,restoreSiteTab} from './existing-tabs.js';
import {sellerDomOperation} from './seller-dom.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function sellerDaily({settings,records,day,profileId,storage,rpc,openSession,log}){
 if(records.sellerBarrierError===day||!sellerScheduleReady(settings,records,day))return;
 const accounts=sellerAccounts(settings);
 if(!accounts.length&&records.sellerBarrierDay===day)return;
 let ready;
 try{ready=await rpc('extension_seller_daily_barrier',{p_day:day,p_profile_id:profileId,p_account_ids:settings.accounts.filter(a=>a.enabled).map(a=>a.id)});await storage.set({sellerBarrierDay:day});}
 catch(error){await storage.set({sellerBarrierError:day});await log('error','販売確認の開始条件を確認できません。再試行せず停止しました');return;}
 if(!ready||!accounts.length)return;
 await storage.set({sellerDailyAttempt:{day,status:'running',at:new Date().toISOString()}});
 let updated=0,errors=0;
 try{
  const context=await rpc('seller_sync_context',{p_account_ids:accounts.map(a=>a.id)});
  for(const account of accounts){let session;
   try{session=await openSession(account);const targets=context.filter(item=>item.account_id===account.id);if(!targets.length)continue;
    const queue=[],seen=new Set(),processed=new Set();
    const enqueue=links=>{for(const link of links){let phase=link.text;if(phase==='出品した商品'||phase==='出品一覧')phase=null;if(![null,'出品中','取引中','売却済み','出品終了分','売上金管理'].includes(phase))continue;const url=sellerUrl(account,link.url);if(!seen.has(url)&&!queue.some(value=>value.url===url))queue.push({url,phase});}queue.sort((a,b)=>(a.phase==='売却済み'||a.phase==='売上金管理'?1:0)-(b.phase==='売却済み'||b.phase==='売上金管理'?1:0));};
    enqueue(await session.links());if(!queue.length){await session.go(account.site==='mercari'?'https://jp.mercari.com/mypage':'https://auctions.yahoo.co.jp/my');enqueue(await session.links());}
    if(!queue.length)throw Error('出品一覧へのリンクを確認できません');
    for(let pageCount=0;queue.length;pageCount++){
     if(pageCount>=200)throw Error('一覧の確認上限に達しました。未確認の商品は変更しません');
     const page=queue.shift();if(seen.has(page.url))continue;seen.add(page.url);await session.go(page.url);let data=await session.read(page.phase);
     enqueue(data.navigation.filter(link=>link.text!=='次へ'));
     const next=data.navigation.filter(link=>link.text==='次へ'||link.text==='次のページ'||link.text==='次');
     for(const link of next){const url=sellerUrl(account,link.url);if(seen.has(url))throw Error('一覧のページ送りが循環しています');queue.unshift({url,phase:page.phase});}
     if(!data.rows.length&&!data.empty&&page.phase){if(await session.selectTab(page.phase))data=await session.read(page.phase);}
     if(page.phase&&!data.rows.length&&!data.empty&&!data.itemCount)throw Error('商品一覧を確認できません');
     const rows=sellerTarget(data.rows,targets);
     for(const row of rows){const key=row.external_id+'/'+row.status;if(processed.has(key))continue;processed.add(key);
      let extra={};if(['取引中','販売済','キャンセル'].includes(row.status)){
       const detail=await session.detail(row.detail_url,row.external_id);
       if(row.status==='販売済')extra=parseSellerSaleDetail(account.site==='mercari'?'メルカリ':'ヤフオク',detail.text,row.external_id);
       else{const label=account.site==='mercari'?'購入日時':'(?:落札日時|終了日時|取引日)';const m=detail.text.replace(/\s+/g,' ').match(new RegExp(label+'\\s*[:：]?\\s*(20[0-9]{2})[年/.-]([0-9]{1,2})[月/.-]([0-9]{1,2})(?:日)?(?:\\s+([0-9]{1,2})[:：]([0-9]{2}))?'));if(m)extra.trade_key=row.external_id+':'+m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')+(m[4]?'T'+m[4].padStart(2,'0')+':'+m[5]:'');}
       extra.trade_url=detail.url;extra.attention=/キャンセル|中止/.test(detail.text);
      }
      const result=await rpc('sync_seller_observation',{p_account_id:account.id,p_observation:{...row,...extra,observed_at:new Date().toISOString()}});if(result==='updated')updated++;
     }
    }
   }catch(error){errors++;await log('error',account.label+'の販売確認を停止しました。自動再試行はしません：'+error.message);}
   finally{await session?.close();}
  }
 }catch(error){errors++;await log('error','販売確認を停止しました：'+error.message);}
 await storage.set({sellerDailyAttempt:{day,status:errors?'failed':'completed',updated,errors,at:new Date().toISOString()}});
}
/** A claimed write is never reclaimed after failure, suspension, or an uncertain outcome. */
export async function sellerQueuedOperations({settings,rpc,openSession,log}){
 const accounts=sellerAccounts(settings);if(settings.mode==='diagnostic'||!accounts.length)return;
 const queue=await rpc('extension_seller_queue',{p_account_ids:accounts.map(a=>a.id)});if(!Array.isArray(queue)||!queue.length)return;
 const job=queue[0],account=accounts.find(value=>value.id===job.account_id);if(!account||!await rpc('extension_claim_seller_operation',{p_id:job.id,p_account_id:account.id}))return;
 let session,status='failed',result={},mutating=false;
 try{session=await openSession(account);
  if(job.kind==='listing'){
   const links=await session.links(),listing=links.find(link=>/^(出品|出品する|出品フォーム)$/.test(link.text));if(!listing)throw Error('出品フォームへのリンクを確認できません');await session.go(listing.url);
   const files=[];let total=0;for(const [index,url] of job.payload.photos.entries()){
    const source=new URL(url);if(source.protocol!=='https:'||!['xgoppuqoqeppckyunnvx.supabase.co','lh3.googleusercontent.com','drive.google.com','drive.usercontent.google.com','drive.googleusercontent.com'].includes(source.hostname))throw Error('写真の取得先を確認できません');
    const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('写真を取得できません');const blob=await response.blob();if(!['image/jpeg','image/png','image/webp'].includes(blob.type)||blob.size>8*1024*1024)throw Error('写真の形式・容量を確認してください');total+=blob.size;if(total>20*1024*1024)throw Error('出品写真の合計容量が20MBを超えています');files.push({name:`photo-${index+1}.`+(blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg'),type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]});
   }
   await session.operation(job,'prepare_listing',{files});
   // Persisting the claim precedes the only publish attempt. A timeout is uncertain, never retried.
   mutating=true;let sent=await session.operation(job,'publish');
   if(sent.confirmation){await session.loaded();sent=await session.operation(job,'publish_confirmation');}
   await session.loaded();const listingResult=await session.operation(job,'listing_result');result=listingResult;
  }else{
   if(!job.url)throw Error('取引URLを取得できません');await session.go(job.url);
   mutating=['register_package','ship_notice','message_send','shipping_code'].includes(job.kind);
   result=await session.operation(job,job.kind);
  }
  status='succeeded';
 }catch(error){status=mutating?'uncertain':'failed';result={note:error.message};await log('error','販売サイトの操作を停止しました。自動再送はしません：'+error.message);}
 finally{await session?.close();}
 await rpc('extension_finish_seller_operation',{p_id:job.id,p_status:status,p_result:result});
}
export async function openSellerSession(account,{tabs,scripting,identity}){
 const borrowed=await borrowSiteTab(tabs,account.site);let last=borrowed.originalUrl;
 async function loaded(){for(let n=0;n<60;n++){const tab=await tabs.get(borrowed.id);if(tab.status==='complete'){sellerUrl(account,tab.url);last=tab.url;borrowed.lastUrl=last;await pause(800);return;}await pause(300);}throw Error('販売画面の読み込みが時間切れになりました');}
 async function go(url){sellerUrl(account,url);const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('利用者が画面を変更したため停止しました');await tabs.update(borrowed.id,{url,active:account.site==='mercari'});last=url;borrowed.lastUrl=url;await loaded();}
 async function execute(func,args){const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('利用者が画面を変更したため停止しました');const results=await scripting.executeScript({target:{tabId:borrowed.id},func,args:[args]});if(results[0]?.result===undefined)throw Error('販売画面から結果を取得できません');if(results[0]?.result?.__error)throw Error(results[0].result.__error);return results[0]?.result;}
 try{await go(account.identity.pageUrl||account.listUrl);const verified=await identity(borrowed.id,account);if(verified?.confirmed!==true)throw Error('出品アカウントを確認できません');}catch(error){await restoreSiteTab(tabs,borrowed).catch(()=>{});throw error;}
 const raw=()=>execute(function(){const text=document.body.innerText;if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|ロボットではない|認証コードを入力/.test(text))throw Error('追加認証が必要です');return {text,url:location.href,links:[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length).map(a=>({text:a.innerText.trim(),url:a.href}))};},null);
 return {go,loaded,structure:()=>execute(readSellerStructure,null),
  links:async()=> (await raw()).links.filter(link=>/^(出品した商品|出品一覧|出品中|取引中|売却済み|出品終了分|売上金管理|出品|出品する|出品フォーム)$/.test(link.text)),
  read:phase=>execute(readSellerPage,{site:account.site,phase}),
  selectTab:label=>execute(async function(label){const candidates=[...document.querySelectorAll('button,[role="tab"]')].filter(e=>e.getClientRects().length&&e.innerText.trim()===label);if(candidates.length!==1)return false;const before=document.body.innerText;const button=candidates[0];button.click();for(let n=0;n<20;n++){await new Promise(resolve=>setTimeout(resolve,200));if(button.getAttribute('aria-selected')==='true'||document.body.innerText!==before)return true;}throw Error('一覧タブの切り替え結果を確認できません');},label),
  detail:async(url,id)=>{await go(url);let page=await raw();if(!/取引画面|取引情報|受け取り明細/.test(page.text)){const options=page.links.filter(link=>/取引画面|取引ナビ|取引情報|詳細/.test(link.text)&&link.url.includes(id));if(options.length!==1)throw Error('販売明細へのリンクを特定できません');await go(options[0].url);page=await raw();}if(!page.text.includes(id))throw Error('取引の商品IDを確認できません');return page;},
  operation:(job,phase,extra={})=>execute(sellerDomOperation,{job,phase,...extra}),
  close:()=>restoreSiteTab(tabs,borrowed).catch(()=>{}),
 };
}
