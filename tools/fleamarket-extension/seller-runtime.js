import {yahooReceiptPage} from './yahoo-receipt.js';
import {readBuyerTodoState} from './todo-audit.js';
import {pacedTabs,paceNavigation} from './navigation-pacing.js';
import {processDailyShipping,readOutboundReceipt,parseCarrierReceipts} from './daily-shipping.js';
import {readSellerStructure,readInspectionTarget,readShippingInspectionTarget} from './seller-inspection.js?v=0.1.143';
import {sellerScheduleReady,sellerHourlyReady,sellerCachedObservation,sellerObservationFingerprint,sellerAccounts,sellerUrl,sellerTarget,readSellerPage,parseSellerSaleDetail} from './seller-sync.js?v=0.1.143';
import {borrowSiteTab,restoreSiteTab} from './existing-tabs.js';
import {sellerDomOperation} from './seller-dom.js?v=0.1.143';
import {processSellerFeedback,mercariSellerFeedback} from './seller-feedback.js';
import {yahooSellerFeedback,yahooSellerRating} from './seller-yahoo-feedback.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function normalizeSellerPhoto({file,site}){
 if(site!=='auctions'||file.type==='image/jpeg')return file;
 const bitmap=await createImageBitmap(new Blob([new Uint8Array(file.bytes)],{type:file.type}));
 try{if(bitmap.width*bitmap.height>40000000)throw Error('出品写真の解像度が大きすぎます');const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');if(!context)throw Error('写真の形式を変換できません');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0);const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.95});if(blob.size>8*1024*1024)throw Error('変換後の写真が8MBを超えています');return {...file,name:file.name.replace(/\.[^.]+$/,'.jpg'),type:'image/jpeg',bytes:[...new Uint8Array(await blob.arrayBuffer())]};}finally{bitmap.close();}
}
/** Return before a full-page category navigation destroys this execution frame. */
export async function clickSellerChoice(kind){
 const names={category:['カテゴリーを選択する','カテゴリを選択する'],condition:['商品の状態を選択する'],shipping:['配送の方法を選択する'],'category-search':['キーワードから選択する（出品カテゴリ検索）'],'shipping-details':['商品サイズと発送場所を選択する']};
 if(!names[kind])throw Error('未対応の選択画面です');
 const norm=s=>String(s||'').replace(/\s+/g,'').trim();let candidates=[];const end=Date.now()+10000;
 const shippingEdit=e=>kind==='shipping-details'&&e.tagName==='A'&&location.hostname==='jp.mercari.com'&&/^\/transaction\/m[0-9]+$/.test(location.pathname)&&e.origin===location.origin&&e.pathname===location.pathname+'/shipping_class';
 const listingEdit=e=>e.tagName==='A'&&location.hostname==='jp.mercari.com'&&location.pathname==='/sell/create'&&e.origin===location.origin&&e.pathname===({category:'/sell/categories',condition:'/sell/conditions',shipping:'/sell/shipping_methods'})[kind];
 while(Date.now()<end){candidates=[...document.querySelectorAll('a,button,input[type="button"]')].filter(e=>e.getClientRects().length&&(names[kind].some(name=>norm(name)===norm(e.innerText||e.getAttribute('aria-label')||e.value))||(kind==='category'&&e.id==='acMdCateChange')||shippingEdit(e)||listingEdit(e)));if(candidates.length)break;await new Promise(resolve=>setTimeout(resolve,250));}
 if(!candidates.length)return false;if(candidates.length!==1||candidates[0].disabled)throw Error('選択画面の入口が曖昧です');
 const before={url:location.href,text:document.body.innerText,controls:[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>[e.id,e.name,e.type].join('|')).join(';')};setTimeout(()=>candidates[0].click(),100);return before;
}
/** Only the site's public category search; never a listing form submit. */
export function searchSellerCategory(term){
 if(typeof term!=='string'||!term.trim()||term.length>200)throw Error('出品カテゴリを確認してください');
 const yahoo=location.hostname==='auctions.yahoo.co.jp'&&/\/show\/topsubmit$/.test(location.pathname),mercari=location.hostname==='jp.mercari.com'&&['/sell/categories','/sell/create'].includes(location.pathname);
 if(!yahoo&&!mercari)throw Error('カテゴリ検索画面ではありません');
 const inputs=[...document.querySelectorAll(yahoo?'input#category-search-keyword':'input')].filter(e=>e.getClientRects().length&&(yahoo||/カテゴリー名を検索/.test(e.getAttribute('placeholder')||e.getAttribute('aria-label')||'')));
 if(inputs.length!==1)throw Error('カテゴリ検索欄を1件に確認できません');
 const before={url:location.href,text:document.body.innerText,controls:[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>[e.id,e.name,e.type].join('|')).join(';')};
 const input=inputs[0];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,term);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
 if(yahoo){const buttons=[...input.form.querySelectorAll('input[type=submit],button')].filter(e=>e.getClientRects().length&&(e.innerText||e.value||'').replace(/\s/g,'')==='検索');if(buttons.length!==1)throw Error('カテゴリ検索ボタンを1件に確認できません');setTimeout(()=>buttons[0].click(),100);}
 return before;
}
export async function resolveYahooCategory(target){
 if(location.hostname!=='auctions.yahoo.co.jp'||!/\/show\/topsubmit$/.test(location.pathname))throw Error('ヤフオクのカテゴリ検索結果ではありません');
 const norm=s=>String(s||'').replace(/（出品されている商品）/g,'').replace(/\s/g,'').replace(/＞/g,'>');const wanted=norm(target);
 const end=Date.now()+10000;while(Date.now()<end){
  const radios=[...document.querySelectorAll('input[type=radio][name=category]')].filter(e=>e.getClientRects().length&&!e.disabled);
  if(radios.length){const matches=radios.filter(e=>{const path=norm([...e.labels].map(l=>l.innerText).join(' '));return path===wanted||path.endsWith('>'+wanted);});if(matches.length!==1||!/^\d+$/.test(matches[0].value))throw Error('出品カテゴリを1件に特定できません。メーカーまで指定してください');return {categoryId:matches[0].value};}
  await new Promise(resolve=>setTimeout(resolve,250));
 }throw Error('カテゴリの検索結果を確認できません');
}
export function sellerChoiceReady(kind){
 const visible=e=>!!e&&e.getClientRects().length>0;
 if(location.hostname==='jp.mercari.com'){
  if(kind==='listing-form')return !!document.querySelector('input[type=file]')&&/出品/.test(document.body.innerText);
  if(kind==='listing-category-return')return !!document.querySelector('input[type=file]')||location.pathname==='/sell/wizard'&&[...document.querySelectorAll('button')].some(e=>visible(e)&&e.innerText.trim()==='出品画面に戻る');
  if(kind==='category')return [...document.querySelectorAll('input')].some(e=>visible(e)&&/カテゴリー名を検索/.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));
  if(kind==='condition')return [...document.querySelectorAll('[data-testid^="condition-"]')].some(visible);
  if(kind==='shipping-details')return location.pathname.startsWith('/transaction/')&&[...document.querySelectorAll('[role=dialog],select,input[type=radio]')].some(visible);
  if(kind==='shipping-place')return /^\/transaction\/m[0-9]+\/shipping_facilities$/.test(location.pathname)&&[...document.querySelectorAll('input[type=radio]')].some(visible)&&[...document.querySelectorAll('button')].some(e=>visible(e)&&e.innerText.trim()==='選択して完了する');
  if(kind==='shipping-code-ready')return /^\/transaction\/m[0-9]+$/.test(location.pathname)&&[...document.querySelectorAll('button')].some(e=>visible(e)&&['配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示','発送用QRコードを発行','発送用バーコードを発行','発送用2次元コードを発行'].includes(e.innerText.trim()));
  if(kind==='shipping')return [...document.querySelectorAll('input[name="selectedShippingMethod"]')].some(visible);
 }else if(location.hostname==='auctions.yahoo.co.jp'){
  if(kind==='category')return /\/show\/topsubmit$/.test(location.pathname)&&[...document.querySelectorAll('a')].some(e=>visible(e)&&/キーワードから選択する/.test(e.innerText));
  if(kind==='category-search')return visible(document.querySelector('#category-search-keyword'));
 }return false;
}
export async function selectMercariListingChoice({kind,value}){
 try{
 if(location.hostname!=='jp.mercari.com'||!['category','condition','shipping'].includes(kind)||!/^\/sell\//.test(location.pathname))throw Error('メルカリの選択画面ではありません');
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim(),target=norm(value),visible=e=>e.getClientRects().length>0&&!e.disabled;const end=Date.now()+12000;
 while(Date.now()<end){const scope=[...document.querySelectorAll('[role=dialog]')].filter(visible).at(-1)||document.querySelector('main')||document.body;let choices;
  if(kind==='condition')choices=[...scope.querySelectorAll('[data-testid^="condition-"]')].filter(e=>visible(e)&&/^condition-[1-6]-row$/.test(e.getAttribute('data-testid'))&&(norm(e.innerText)===target||norm(e.innerText).startsWith(target+' ')));
  else if(kind==='shipping')choices=[...scope.querySelectorAll('input[type=radio][name=selectedShippingMethod]')].filter(e=>visible(e)&&[...e.labels].map(l=>l.innerText).concat((e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.innerText)).some(t=>norm(t)===target||norm(t).startsWith(target+' ')));
  else choices=[...scope.querySelectorAll('a')].filter(e=>visible(e)&&(norm(e.innerText)===target||norm(e.innerText).startsWith(target+' ')));
  if(choices.length>1)throw Error('選択肢が曖昧なため停止しました');if(choices.length===1){const before={url:location.href};if(kind==='shipping'){const updates=[...document.querySelectorAll('button')].filter(e=>visible(e)&&norm(e.innerText)==='更新する');if(updates.length>1)throw Error('配送方法の更新ボタンが曖昧です');if(updates.length===1){if(!choices[0].checked)choices[0].click();if(!choices[0].checked)throw Error('配送方法の選択結果を確認できません');setTimeout(()=>updates[0].click(),100);return before;}}setTimeout(()=>choices[0].click(),100);return before;}await new Promise(resolve=>setTimeout(resolve,200));
 }throw Error('選択肢を1件に確認できません：'+kind);
 }catch(error){return {__error:error.message};}
}
export function mercariListingChoiceSelected({kind,value}){
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/sell/create')return false;const path=({category:'/sell/categories',condition:'/sell/conditions',shipping:'/sell/shipping_methods'})[kind];if(!path)return false;
 const links=[...document.querySelectorAll('a')].filter(e=>e.getClientRects().length&&e.origin===location.origin&&e.pathname===path);if(links.length!==1)return false;
 for(let group=links[0].parentElement,n=0;group&&n<3;group=group.parentElement,n++){if(group.querySelector('input[name=name],textarea')||group.innerText.length>400)break;if(group.innerText.replace(/\s+/g,' ').includes(value))return true;}return false;
}
export function returnMercariListingForm(){
 if(location.hostname!=='jp.mercari.com')return {__error:'メルカリではありません'};if(location.pathname==='/sell/create'&&document.querySelector('input[type=file]'))return false;if(location.pathname!=='/sell/wizard')return {__error:'出品フォームへの復帰画面ではありません'};
 const buttons=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&!e.disabled&&e.innerText.trim()==='出品画面に戻る');if(buttons.length!==1)return {__error:'出品画面へ戻る操作を1件に確認できません'};const before={url:location.href};setTimeout(()=>buttons[0].click(),100);return before;
}
/** Advance only the size step, never the place confirmation or QR issuance. */
export function advanceMercariShippingSize({itemId,size,shippingMethod='らくらくメルカリ便'}){
 try{
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId+'/shipping_class'||!/^m[0-9]{8,14}$/.test(itemId))throw Error('対象取引のサイズ選択画面ではありません');
 const norm=s=>String(s||'').replace(/\s/g,'').replace(/[〜～−–]/g,'-'),visible=e=>e.getClientRects().length>0;
 const wanted=['100','140'].includes(String(size))?shippingMethod==='らくらくメルカリ便'?'宅急便60-160':shippingMethod==='ゆうゆうメルカリ便'?'ゆうパック':null:['宅急便コンパクト','ゆうパケットプラス','ゆうパケット'].includes(size)?size:null;if(!wanted)throw Error('配送サイズを確認できません');
 const radios=[...document.querySelectorAll('input[type=radio]')].filter(e=>{if(!visible(e)||e.disabled)return false;const value=norm(e.value);if(value===wanted)return true;if(wanted!=='ゆうパック')return false;const range=value.match(/^ゆうパック(60|120)-(100|170)$/);return !!range&&Number(size)>=Number(range[1])&&Number(size)<=Number(range[2]);});
 const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.innerText.trim()==='選択して次へ');if(radios.length!==1||buttons.length!==1)throw Error('サイズ選択の項目を1件に確認できません');
 const before={url:location.href,text:document.body.innerText,controls:''};if(!radios[0].checked)radios[0].click();if(!radios[0].checked)throw Error('サイズ選択を確認できません');setTimeout(()=>buttons[0].click(),100);return before;
 }catch(error){return {__error:error.message};}
}
/** Called only for an app-requested shipping operation, not a display inspection. */
export function advanceMercariShippingPlace({itemId,dropoff}){
 try{
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId+'/shipping_facilities'||!/^m[0-9]{8,14}$/.test(itemId))throw Error('対象取引の発送場所選択画面ではありません');
 const visible=e=>e.getClientRects().length>0,norm=s=>String(s||'').replace(/[\s\-−–]/g,'');
 const values={'セブンイレブン':'SEVEN_ELEVEN','ヤマト営業所':'YAMATO_OFFICE'},postal={'ローソン':'ローソン','郵便局':'郵便局'};
 const wanted=values[dropoff],label=postal[dropoff];if(!wanted&&!label)throw Error('発送場所を確認できません');
 const radioLabel=e=>norm([e.getAttribute('aria-label'),...[...(e.labels||[])].map(l=>l.innerText),...(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.innerText)].filter(Boolean).join(' '));
 const radios=[...document.querySelectorAll('input[type=radio]')].filter(e=>visible(e)&&!e.disabled&&(wanted?e.value===wanted:radioLabel(e).startsWith(label)||norm(e.value)===label));
 const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.innerText.trim()==='選択して完了する');if(radios.length!==1||buttons.length!==1)throw Error('発送場所の選択肢を1件に確認できません');
 const before={url:location.href,text:document.body.innerText,controls:''};if(!radios[0].checked)radios[0].click();if(!radios[0].checked)throw Error('発送場所の選択を確認できません');setTimeout(()=>buttons[0].click(),100);return before;
 }catch(error){return {__error:error.message};}
}
export async function sellerDaily({settings,records,day,profileId,storage,rpc,openSession,log,repair=null,hourly=false,now=Date.now(),feedbackSites=[],automaticShipping=false}){
 if(hourly&&!sellerHourlyReady(settings,records,now))return;
 if(hourly&&repair)throw Error('4時間ごと確認と修復は同時実行できません');
 if(!hourly&&!repair&&(records.sellerBarrierError===day||!sellerScheduleReady(settings,records,day)))return;
 const accounts=sellerAccounts(settings).filter(account=>!repair||account.id===repair.accountId);if(!accounts.length&&records.sellerBarrierDay===day)return;
 const attemptKey=hourly?'sellerHourlyAttempt':repair?'sellerRepairAttempt':'sellerDailyAttempt',metadata=hourly?{intervalMinutes:240,startedAt:new Date(now).toISOString()}:repair?{requestId:repair.id,accountId:repair.accountId}:{};
 let ready=true;
 if(!repair&&!hourly){
 try{ready=await rpc('extension_seller_daily_barrier',{p_day:day,p_profile_id:profileId,p_account_ids:settings.accounts.filter(a=>a.enabled).map(a=>a.id)});await storage.set({sellerBarrierDay:day});}
 catch(error){await storage.set({sellerBarrierError:day});await log('error','販売確認の開始条件を確認できません。再試行せず停止しました');return;}
 }
 if(!ready||!accounts.length)return;
 let responseBytes=0,rpcCalls=0,cacheHits=0;const baseRpc=rpc;
 const observationCache={...(records.sellerObservationCache?.version===1?records.sellerObservationCache.accounts:{})};
 rpc=async(...args)=>{const value=await baseRpc(...args);rpcCalls++;responseBytes+=new TextEncoder().encode(JSON.stringify(value)??'null').length;return value;};
 await storage.set({[attemptKey]:{...metadata,day,status:'running',at:new Date().toISOString()}});
 let shippingJobs=[];
 if(automaticShipping&&!hourly&&!repair&&new Date(now+9*3600000).getUTCHours()>=1){
  try{shippingJobs=await rpc('extension_daily_shipping_candidates',{p_account_ids:accounts.map(a=>a.id)});if(!Array.isArray(shippingJobs))throw Error('自動発送通知の対象を確認できません');}
  catch(e){await log('error','自動発送通知の対象確認を翌日に回します：'+e.message);}
 }
 const baselines={...(records.sellerSaleBackfills||{})};let updated=0,errors=0,unmatched=0,conflicts=0;const failures=[];
 for(const account of accounts){let session;
  const cache=Object.fromEntries(Object.entries(observationCache[account.id]||{}).filter(([,v])=>Number.isFinite(v?.checkedAt)&&now-v.checkedAt>=0&&now-v.checkedAt<24*60*60000));
  const remember=row=>{if(['出品中','取引中','支払い待ち'].includes(row.status))cache[row.external_id]={fingerprint:sellerObservationFingerprint(row),checkedAt:now};};
  try{
   session=await openSession(account);
   const queue=[],seen=new Set(),processed=new Set(),pending=[],feedbackRows=new Map(),fullScan=baselines[account.id]!=='serial-case-v2';
   let registeredRun=0,salesStopped=false,salesSeen=false,batches=0;const auctionSaleIds=new Set();
   const salePhase=phase=>phase==='売却済み'||phase==='売上金管理';
   const enqueue=links=>{for(const link of links){let phase=link.text;if(phase==='出品した商品'||phase==='出品一覧')phase=null;if(![null,'出品中','取引中','売却済み','出品終了分','売上金管理'].includes(phase))continue;if((salesStopped||hourly)&&salePhase(phase))continue;const url=sellerUrl(account,link.url);if(!seen.has(url)&&!queue.some(v=>v.url===url))queue.push({url,phase});}queue.sort((a,b)=>(salePhase(a.phase)?1:0)-(salePhase(b.phase)?1:0));};
   const menu=await session.links();enqueue(menu);if(!queue.length){await session.go(account.site==='mercari'?'https://jp.mercari.com/mypage':'https://auctions.yahoo.co.jp/my');enqueue(await session.links());}
   if(!queue.length)throw Error('出品一覧へのリンクを確認できません');
   while(queue.length){
    const page=queue.shift();if(seen.has(page.url)||salesStopped&&salePhase(page.phase))continue;
    seen.add(page.url);await session.go(page.url);
    while(true){
     if(++batches>200)throw Error('一覧の確認上限に達しました。初回照合は完了扱いにしません');
     let data=await session.read(page.phase);
     if(!data.rows.length&&!data.empty&&page.phase&&session.selectTab){if(await session.selectTab(page.phase))data=await session.read(page.phase);}
     for(const row of data.rows)if(row.feedback_pending===true&&!row.attention)feedbackRows.set(row.external_id,row);
     if(page.phase&&!data.rows.length&&!data.empty&&!data.itemCount)throw Error('商品一覧を確認できません：'+page.phase+' ('+new URL(page.url).pathname+')');
     if(salePhase(page.phase))salesSeen=true;
     // Count all visible sale-management products, including unpaid/unsettled rows.
     if(account.site==='auctions'&&page.phase==='売上金管理'){
      for(const id of data.itemIds||data.rows.map(row=>row.external_id)){
       if(auctionSaleIds.has(id))continue;
       if(auctionSaleIds.size>=40)break;
       auctionSaleIds.add(id);
      }
      if(auctionSaleIds.size>=40)salesStopped=true;
     }
     const candidates=data.rows.filter(row=>(!hourly||['出品中','取引中','支払い待ち','キャンセル'].includes(row.status))&&!processed.has(row.external_id+'/'+row.status)
      &&(account.site!=='auctions'||page.phase!=='売上金管理'||auctionSaleIds.has(row.external_id)));
     const rows=candidates.filter(row=>{if(hourly&&sellerCachedObservation(cache,row,now)){processed.add(row.external_id+'/'+row.status);cacheHits++;return false;}return true;});
     const plans=new Map();
     for(let offset=0;offset<rows.length;offset+=100){
      const batch=rows.slice(offset,offset+100),result=await rpc('seller_observation_plan',{p_account_id:account.id,p_rows:batch});
      if(!Array.isArray(result)||result.length!==batch.length)throw Error('販売情報の登録状況を確認できません');
      for(const plan of result){if(!['registered','unchanged','unmatched','protected','detail','apply'].includes(plan.action)||plans.has(plan.external_id))throw Error('販売情報の照合結果を確認できません');plans.set(plan.external_id,plan.action);}
     }
     for(const row of rows){
      const action=plans.get(row.external_id);if(!action)throw Error('販売情報の照合結果がありません');
      processed.add(row.external_id+'/'+row.status);
      if(salePhase(page.phase)&&account.site==='mercari'){
       registeredRun=action==='registered'?registeredRun+1:0;
       if(!fullScan&&registeredRun>=5){salesStopped=true;break;}
      }
      if(action==='unmatched'){unmatched++;continue;}
      if(action==='registered'||action==='unchanged'){remember(row);continue;}
      if(action==='protected')continue;
      pending.push({row,action});
     }
     if(salesStopped&&salePhase(page.phase))break;
     const next=data.navigation.filter(link=>['次へ','次のページ','次'].includes(link.text));
     enqueue(data.navigation.filter(link=>!['次へ','次のページ','次'].includes(link.text)));
     if(next.length){for(const link of next.reverse()){const url=sellerUrl(account,link.url);if(seen.has(url))throw Error('一覧のページ送りが循環しています');queue.unshift({url,phase:page.phase});}break;}
     if(account.site!=='mercari'||!['出品中','取引中','売却済み'].includes(page.phase)||!session.advanceList||!await session.advanceList(page.phase))break;
     const after=await session.read(page.phase);
     if(!after.rows.some(row=>!processed.has(row.external_id+'/'+row.status)))throw Error('追加の一覧を確認できません。再試行しません');
    }
   }
   // Daily lifecycle: shipping -> buyer feedback -> final sales reconciliation.
   // Lists above are shared preflight evidence; never add a second marketplace scan.
   if(!hourly&&!repair&&shippingJobs.some(j=>j.account_id===account.id))await processDailyShipping({jobs:shippingJobs.filter(j=>j.account_id===account.id),session,rpc,log});
   let feedbackChecks={};
   if(!hourly&&feedbackSites.includes(account.site)&&feedbackRows.size){
    const feedback=await processSellerFeedback({account,rows:[...feedbackRows.values()],session,rpc,storage,log,now});
    if(feedback.errors)throw Error('購入者評価の結果確認が必要なため、このアカウントの販売反映を保留しました');
    feedbackChecks=(await storage.get('sellerFeedbackChecks')).sellerFeedbackChecks||{};
    if(account.site==='mercari')for(const row of feedbackRows.values()){
     if(feedbackChecks[account.id+':'+row.external_id]?.state==='succeeded'&&!pending.some(v=>v.row.external_id===row.external_id))pending.push({row,action:'detail'});
    }
   }
   // Details are opened after harvesting lists so returning from a detail cannot reset infinite-scroll progress.
   for(const observation of pending){
    let {row,action}=observation;
    // Do not apply a transaction row collected before a successful evaluation.
    const feedbackState=feedbackChecks[account.id+':'+row.external_id]?.state;
    if(feedbackState==='unknown')continue;
    if(account.site==='mercari'&&feedbackState==='succeeded'&&row.status==='取引中'){
     row={...row,status:'販売済'};action='detail';
    }
    try{
    let extra={};if(action==='detail'){
     const detail=await session.detail(row.detail_url,row.external_id);
     if(row.status==='販売済'){try{extra=parseSellerSaleDetail(account.site==='mercari'?'メルカリ':'ヤフオク',detail.text,row.external_id,detail.url);}catch(error){if(account.site!=='auctions'||!session.auctionDetail||!error.message.includes('実際の販売日'))throw error;const auction=await session.auctionDetail(row.external_id);extra=parseSellerSaleDetail('ヤフオク',detail.text,row.external_id,detail.url,auction);}}
     else{const label=account.site==='mercari'?'購入日時':'(?:落札日時|終了日時|取引日)';const m=detail.text.replace(/\s+/g,' ').match(new RegExp(label+'\\s*[:：]?\\s*(20[0-9]{2})[年/.-]([0-9]{1,2})[月/.-]([0-9]{1,2})(?:日)?(?:\\s+([0-9]{1,2})[:：]([0-9]{2}))?'));if(m)extra.trade_key=row.external_id+':'+m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')+(m[4]?'T'+m[4].padStart(2,'0')+':'+m[5]:'');}
     extra.trade_url=detail.url;extra.attention=/キャンセル|中止/.test(detail.text);
    }
    const result=await rpc('sync_seller_observation',{p_account_id:account.id,p_observation:{...row,...extra,observed_at:new Date().toISOString()}});
    if(result==='updated'||result==='registered'){updated++;remember(row);}else if(result==='unmatched')unmatched++;else if(result==='conflict')conflicts++;
    }catch(error){throw Error('商品ID '+row.external_id+'：'+error.message);}
   }
   if(fullScan&&salesSeen){baselines[account.id]='serial-case-v2';await storage.set({sellerSaleBackfills:{...baselines}});}
  }catch(error){errors++;failures.push({accountId:account.id,error:error.message});await log('error',account.label+(hourly?'の4時間ごと販売確認を停止しました。次回の定期確認まで再実行しません：':'の販売確認を停止しました。自動再試行はしません：')+error.message);}
  finally{observationCache[account.id]=Object.fromEntries(Object.entries(cache).slice(-2000));await session?.close();}
 }
 if(unmatched||conflicts)await log('warning','販売情報の要確認：商品未一致 '+unmatched+'件、販売実績の不一致 '+conflicts+'件。自動上書きしていません');
 await storage.set({sellerObservationCache:{version:1,accounts:observationCache},[attemptKey]:{...metadata,day,status:errors?'failed':'completed',updated,errors,unmatched,conflicts,responseBytes,rpcCalls,cacheHits,...(repair?{failures}:{}),at:new Date().toISOString()}});
}
/** Explicit repair is consumed once; it never clears or rewrites the normal daily attempt. */
export async function runSellerSaleRepair(dependencies){
 const {settings,records,day,profileId,storage,fetchRequest}=dependencies;
 const request=await fetchRequest(),map={'ba92b386-e0bc-48be-b3b6-ca9550fa1a2d':['auctions-1'],'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':['mercari-1','auctions-2'],'51502a66-28a6-4af0-81ea-660e63d8b66c':['mercari-2']};
 if(!request||request.kind!=='seller-sale-repair'||!/^[-0-9a-f]{36}$/i.test(request.id||'')||!map[profileId]?.includes(request.accountId)||request.profileId!==profileId)return false;
 const now=Date.now(),issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt);
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>15*60000)return false;
 if(settings.mode==='diagnostic'||records.job||records.authProblem||!records.session?.access_token||!settings.accounts.some(a=>a.enabled&&a.id===request.accountId))return false;
 if(!['tracking',...(settings.purchaseImportEnabled?['purchases']:[])].every(kind=>records.scheduledRuns?.[kind]?.day===day&&records.lastRun?.[kind]?.day===day))return false;
 const consumed=(await storage.get('sellerRepairConsumed')).sellerRepairConsumed||[];
 if(consumed.includes(request.id))return false;
 await storage.set({sellerRepairConsumed:[...consumed,request.id].slice(-32)});
 await sellerDaily({...dependencies,repair:{id:request.id,accountId:request.accountId}});
 return true;
}
/** Read an existing listing without opening or submitting a listing form. */
export async function checkExistingListing(session,job,account){
 const serial=String(job.inventory_sku||'').split('-')[0].toLowerCase(),target=job.result?.read_check_url;
 const targetId=target?.match(account.site==='mercari'?/^https:\/\/jp[.]mercari[.]com\/item\/(m[0-9]+)$/:/^https:\/\/page[.]auctions[.]yahoo[.]co[.]jp\/jp\/auction\/([a-z][0-9]+)$/)?.[1];
 if(target&&!targetId)throw Error('出品先の商品URLを確認してください');if(!targetId&&!/^[0-9]+[a-z]*$/.test(serial))throw Error('出品済み商品のURLを入力してください');
 const queue=[],seen=new Set(),matches=new Map();
 const enqueue=links=>{for(const link of links)if(['出品した商品','出品一覧','出品中','次へ','次のページ','次'].includes(link.text)){const url=sellerUrl(account,link.url);if(!seen.has(url)&&!queue.includes(url))queue.push(url);}};
 const menu=await session.links();enqueue(menu);if(!queue.length)throw Error('出品一覧へのリンクを確認できません');
 let pages=0;
 while(queue.length){if(++pages>5)throw Error('出品結果の確認上限に達しました');const url=queue.shift();seen.add(url);await session.go(url);
  for(let batch=0;;batch++){
   if(batch>5)throw Error('出品結果の確認上限に達しました');let data=await session.read('出品中');
   if(data.active&&data.active!=='出品中'&&session.selectTab&&await session.selectTab('出品中'))data=await session.read('出品中');
   for(const row of data.rows)if(row.status==='出品中'&&(targetId?row.external_id===targetId:row.serial?.toLowerCase()===serial))matches.set(row.external_id,row);
   enqueue(data.navigation.filter(link=>['出品中','次へ','次のページ','次'].includes(link.text)));
   if(!session.advanceList||!await session.advanceList())break;
  }
 }
 if(matches.size===0&&targetId&&account.site==='auctions'){
  const closed=[],visited=new Set();const add=links=>{for(const link of links){const url=new URL(sellerUrl(account,link.url));if(url.hostname==='auctions.yahoo.co.jp'&&url.pathname==='/my/closed'&&['出品終了分','落札者なし','次へ','次のページ','次'].includes(link.text)&&!visited.has(url.href)&&!closed.includes(url.href))closed.push(url.href);}};
  add(menu);add(await session.links());let owned=false;
  for(let n=0;closed.length&&n<5;n++){const url=closed.shift();visited.add(url);await session.go(url);if(session.selectTab)await session.selectTab('落札者なし');const data=await session.read('出品終了分');if(data.itemIds?.includes(targetId)){owned=true;break;}add(data.navigation);add(await session.links());}
  if(owned){await session.go(target);const proof=await session.operation({...job,external_id:targetId},'listing_ended');return {...proof,account_id:account.id,ownership_source:'seller_closed_list'};}
 }
 if(matches.size!==1)throw Error('出品済み商品を1件に確認できません。商品URLを入力して確認してください');
 const row=[...matches.values()][0];
 // A seller row may end with statistics/edit/trade links for the same ID.
 // Confirm ownership above, then read the public item page rather than that auxiliary URL.
 if(!(account.site==='mercari'?/^m[0-9]+$/:/^[a-z][0-9]+$/i).test(row.external_id||''))throw Error('出品済み商品のIDを確認できません');
 const publicUrl=account.site==='mercari'?'https://jp.mercari.com/item/'+row.external_id:'https://auctions.yahoo.co.jp/jp/auction/'+row.external_id;
 await session.go(sellerUrl(account,publicUrl));
 const result=await session.operation(job,'listing_result');if(result.external_id!==row.external_id)throw Error('出品済み商品の照合結果が一致しません');return result;
}
/** A claimed write is never reclaimed after failure, suspension, or an uncertain outcome. */
export async function sellerQueuedOperations({settings,rpc,openSession,log}){
 const accounts=sellerAccounts(settings);if(settings.mode==='diagnostic'||!accounts.length)return;
 const queue=await rpc('extension_seller_queue',{p_account_ids:accounts.map(a=>a.id)});if(!Array.isArray(queue)||!queue.length)return;
 const job=queue[0],account=accounts.find(value=>value.id===job.account_id);if(!account)return;
 if(job.read_only_listing_check){
  if(job.kind!=='listing'||!await rpc('extension_claim_listing_result_check',{p_id:job.id,p_account_id:account.id}))return;
  let session,result;try{session=await openSession(account);result=await checkExistingListing(session,job,account);}catch(error){result={note:error.message};await log('warning','出品済み商品の確認を停止しました：'+error.message);}finally{await session?.close();}
  try{await rpc('extension_finish_listing_result_check',{p_id:job.id,p_result:result});}catch(error){await rpc('extension_finish_listing_result_check',{p_id:job.id,p_result:{note:error.message}});}return;
 }
 if(!await rpc('extension_claim_seller_operation',{p_id:job.id,p_account_id:account.id}))return;
 let session,status='failed',result={},mutating=false,phase='prepare',confirmationTrace=[];
 try{session=await openSession(account);
  if(job.kind==='listing'){
   const links=await session.links(),listing=links.find(link=>/^(出品|出品する|出品フォーム)$/.test(link.text));if(!listing)throw Error('出品フォームへのリンクを確認できません');await session.go(listing.url);
   const entry=await session.structure();if(!entry.fileInputs?.length){const direct=(await session.links()).filter(link=>/^(出品|出品する|出品フォーム)$/.test(link.text)&&link.url!==listing.url);if(direct.length!==1)throw Error('出品入力画面への実リンクを1件に確認できません');await session.go(direct[0].url);}
   phase='listing_preflight';await session.operation(job,phase);
   phase='listing_choices';if(account.site==='auctions')await session.prepareCategory(job.payload.listingCategory||job.payload.category);
   else if(session.prepareListingChoices)await session.prepareListingChoices(job);
   phase='download_photos';
   const files=[];let total=0,convertedTotal=0;for(const [index,url] of job.payload.photos.entries()){
    const source=new URL(url);if(source.protocol!=='https:'||!['xgoppuqoqeppckyunnvx.supabase.co','lh3.googleusercontent.com','drive.google.com','drive.usercontent.google.com','drive.googleusercontent.com'].includes(source.hostname))throw Error('写真の取得先を確認できません');
    const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('写真を取得できません');const blob=await response.blob();if(!['image/jpeg','image/png','image/webp'].includes(blob.type)||blob.size>8*1024*1024)throw Error('写真の形式・容量を確認してください');total+=blob.size;if(total>20*1024*1024)throw Error('出品写真の合計容量が20MBを超えています');const photo=await normalizeSellerPhoto({site:account.site,file:{name:`photo-${index+1}.`+(blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg'),type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]}});convertedTotal+=photo.bytes.length;if(convertedTotal>20*1024*1024)throw Error('変換後の出品写真の合計容量が20MBを超えています');files.push(photo);
   }
   phase='prepare_listing';await session.operation(job,phase,{files});
   // Persisting the claim precedes the only publish attempt. A timeout is uncertain, never retried.
   mutating=true;phase='publish';let sent=await session.operation(job,'publish');
   const confirmationSteps=[];let confirmations=0;
   while(sent.confirmation){
    confirmationTrace.push(sent);
    if(++confirmations>3)throw Object.assign(Error('出品確認の画面遷移が多いため確定前に停止しました'),{stoppedBeforePublish:true});
    if(sent.confirmationStep)confirmationSteps.push(sent.confirmationStep);
    await session.loaded();phase='publish_confirmation';sent=await session.operation(job,'publish_confirmation',{confirmationSteps});
   }
   await session.loaded();phase='listing_result';const listingResult=await session.operation(job,'listing_result');result=listingResult;
  }else{
   if(!job.url)throw Error('取引URLを取得できません');await session.go(job.url);
   let shippingPrepared=false;
   if(job.kind==='shipping_code'&&account.site==='mercari'&&session.prepareShipping){const preflight=await session.operation(job,'shipping_preflight');if(preflight.needsEditor){mutating=true;await session.prepareShipping(job);shippingPrepared=true;}else if(preflight.readyForCode){if(preflight.configuredDropoff!==job.payload.dropoff)throw Error('サイトの発送場所がアプリ設定と一致しません');shippingPrepared=true;}}
   let notice;
   if(job.kind==='ship_notice'){phase='ship_notice_preflight';notice=await session.operation(job,phase);}
   if(notice?.alreadyNotified){result={notified:true,already_notified:true,observed_at:notice.observed_at,note:'サイトで発送通知済みを確認しました。再送していません'};}
   else{
    mutating=['register_package','ship_notice','message_send','shipping_code'].includes(job.kind);phase=job.kind;
    result=await session.operation(job,job.kind,{shippingPrepared});
    if(job.kind==='shipping_code'&&result.code_requested){await session.loaded();result=await session.operation(job,'read_shipping_code',{waitForShippingCode:true});}
   }
  }
  status='succeeded';
 }catch(error){status=error.existingListing||mutating&&!error.stoppedBeforePublish?'uncertain':'failed';result={note:error.message,phase,...(confirmationTrace.length?{confirmation_trace:confirmationTrace}:{}),...(error.stoppedBeforePublish?{stopped_before_publish:true,confirmation_evidence:error.confirmationEvidence}:{}),...(error.shippingEvidence?{shipping_evidence:error.shippingEvidence}:{})};
  if(error.stoppedBeforePublish&&session?.structure){try{const view=await session.structure();result.confirmation_structure={headings:view.headings,validationErrors:view.validationErrors,invalidFields:view.invalidFields,notices:view.notices,auctionOptionLabels:view.auctionOptionLabels,fixedAuctionSettings:view.fixedAuctionSettings,publicSettings:view.publicSettings,controls:view.controls?.filter(c=>/自動|確認|出品|設定|エラー/.test(c.label||''))};}catch{}}
  // Navigation can destroy the submit frame. Read its settled result, never submit twice.
  if(mutating&&!error.stoppedBeforePublish&&job.kind==='listing'&&session){try{await session.loaded();result={...await session.operation(job,'listing_result'),recovered_after_navigation:true};status='succeeded';}catch(checkError){result={...result,result_check_note:checkError.message};
   // Read the original account's existing listings once. Never reopen the publish form.
   try{await session.go(sellerUrl(account,account.identity?.pageUrl||account.listUrl));result={...await checkExistingListing(session,job,account),recovered_from_listing_list:true};status='succeeded';}
   catch(listError){result={...result,list_check_note:listError.message};}
  }}
  if(status!=='succeeded')await log('error','販売サイトの操作を停止しました。自動再送はしません：'+error.message);
 }
 finally{await session?.close();}
 await rpc('extension_finish_seller_operation',{p_id:job.id,p_status:status,p_result:result});
}
/** Read-only list expansion. No retry, form submission, or business action. */
export async function advanceSellerList(){
 if(location.hostname!=='jp.mercari.com'||!location.pathname.startsWith('/mypage/listings'))return false;
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const ids=()=>[...document.querySelectorAll('a[href]')].filter(visible).map(e=>e.href.match(/\/(?:item|transaction)\/(m[0-9]+)/)?.[1]).filter(Boolean);
 const before=new Set(ids()),buttons=[...document.querySelectorAll('button,a')].filter(e=>visible(e)&&!e.disabled&&/^(もっと見る|さらに表示|もっと表示する)$/.test(e.innerText.trim()));
 if(buttons.length>1)throw Error('一覧の追加表示ボタンが曖昧です');
 if(buttons.length===1)buttons[0].click();
 else {const scroller=document.scrollingElement;if(!scroller||scroller.scrollHeight<=scroller.clientHeight)return false;scroller.scrollTo(0,scroller.scrollHeight);}
 const end=Date.now()+(buttons.length?15000:6000);
 while(Date.now()<end){if(ids().some(id=>!before.has(id)))return true;await new Promise(r=>setTimeout(r,250));}
 const loading=[...document.querySelectorAll('[data-testid=items-skeleton],[role=progressbar]')].some(visible);
 if(buttons.length||loading)throw Error('一覧の追加読み込みが完了しません。再試行しません');
 return false;
}
/** Await only the existing transaction DOM; no network retry or business controls. */
export async function readMercariTransactionPage({id,timeoutMs=20000}){
 try{
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+id||!/^m[0-9]+$/.test(id))throw Error('対象の取引画面ではありません');
 const end=Date.now()+timeoutMs;let text='';
 do{text=document.body.innerText;
  if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/ログインしてください|認証コードを入力|文字認証|ロボットではない|セキュリティチェック/.test(text))throw Error('ログイン・追加認証が必要なため停止しました');
  const unavailable=['お探しのページは見つかりません','ページが見つかりません','この取引は表示できません','このページは表示できません'].find(value=>text.includes(value));if(unavailable)throw Error('取引明細を表示できません：'+unavailable);
  if(text.includes(id)&&/取引画面|取引情報|商品代金|購入日時/.test(text))return {url:location.href,text,links:[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length).map(a=>({text:a.innerText.trim(),url:a.href}))};
  if(Date.now()<end)await new Promise(resolve=>setTimeout(resolve,250));
 }while(Date.now()<end);
 const flags=['取引画面','商品代金','購入日時','取引が完了しました','取引がキャンセルされました','エラーが発生しました','読み込み中'].filter(value=>text.includes(value));throw Error('取引明細の表示待ちが時間切れになりました（表示：'+(flags.join('・')||'取引情報なし')+'）');
 }catch(error){return {__error:error.message};}
}
/** Return before a list-tab navigation replaces the execution frame. */
export function clickSellerListTab(label){
 const candidates=[...document.querySelectorAll('button,[role="tab"]')].filter(e=>e.getClientRects().length&&e.innerText.trim()===label);
 if(candidates.length!==1)return false;const button=candidates[0];
 if(button.disabled||button.getAttribute('aria-selected')==='true')return {selected:true};
 setTimeout(()=>button.click(),0);return {changing:true};
}
export async function openSellerSession(account,{tabs,scripting,windows,identity,executionTimeoutMs=30000}){
 tabs=pacedTabs(tabs);
 const borrowed=await borrowSiteTab(tabs,account.site);let last=borrowed.originalUrl,categoryResolution=null,listingChoices=null,preserveFeedback=false;
 async function loaded(){for(let n=0;n<60;n++){const tab=await tabs.get(borrowed.id);if(tab.status==='complete'){await pause(800);const settled=await tabs.get(borrowed.id);if(settled.status==='complete'&&settled.url===tab.url){sellerUrl(account,settled.url);last=settled.url;borrowed.lastUrl=last;return;}}await pause(300);}throw Error('販売画面の読み込みが時間切れになりました');}
 async function go(url){sellerUrl(account,url);const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('画面のURLが変更されたため停止しました');const arrived=await tabs.update(borrowed.id,{url,active:account.site==='mercari'});last=url;borrowed.lastUrl=url;if(account.site==='mercari'&&windows&&Number.isInteger(arrived.windowId)){const w=await windows.get(arrived.windowId);if(w.state==='minimized')await windows.update(w.id,{state:'normal'});if(w.state!=='maximized'&&(w.width<1000||w.height<700))await windows.update(w.id,{width:1200,height:900});await windows.update(w.id,{focused:true});}await loaded();}
 async function execute(func,args){
  const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('画面のURLが変更されたため停止しました');let timer;
  try{
   const timeout=args?.phase==='prepare_listing'?Math.max(executionTimeoutMs,120000):func===readSellerPage&&executionTimeoutMs===30000?60000:executionTimeoutMs;
   const results=await Promise.race([scripting.executeScript({target:{tabId:borrowed.id},func,args:[args]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('販売画面の確認が時間切れになりました：'+(args?.phase||func.name||'page')+'。自動再試行しません')),timeout);})]);
   if(results[0]?.error)throw Error('販売画面の読み取りに失敗しました');if(results[0]?.result==null)throw Error('販売画面から結果を取得できません：'+(func.name||'page')+' ('+new URL(last).hostname+new URL(last).pathname+')');if(results[0]?.result?.__error){const value=results[0].result;throw Object.assign(Error(value.__error),{...(value.existingListing?{existingListing:true}:{}),...(value.stoppedBeforePublish?{stoppedBeforePublish:true,confirmationEvidence:value.confirmationEvidence}:{}),...(value.shippingEvidence?{shippingEvidence:value.shippingEvidence}:{})});}return results[0]?.result;
  }finally{clearTimeout(timer);}
 }
 try{await go(account.identity.pageUrl||account.listUrl);const verified=await identity(borrowed.id,account);if(verified?.confirmed!==true)throw Error('出品アカウントを確認できません');}catch(error){await restoreSiteTab(tabs,borrowed).catch(()=>{});throw error;}
 const raw=()=>execute(function(){try{const text=document.body.innerText;if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|ロボットではない|認証コードを入力/.test(text))throw Error('追加認証が必要です');return {text,url:location.href,links:[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length).map(a=>({text:a.innerText.trim(),url:a.href}))};}catch(error){return {__error:error.message};}},null);
 async function finishChoice(before,kind=null){if(!before)return false;await pause(350);await loaded();const end=Date.now()+15000;while(Date.now()<end){if(kind?await execute(sellerChoiceReady,kind):await execute(function(before){return location.href!==before.url||document.body.innerText!==before.text||[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>[e.id,e.name,e.type].join('|')).join(';')!==before.controls;},before)){await loaded();return true;}await pause(250);await loaded();}throw Error((({'shipping-details':'配送サイズ','shipping-place':'発送場所','shipping-code-ready':'配送コード'})[kind]||'選択')+'画面の表示を確認できません。再試行しません');}
 async function categoryForm(target,formUrl){
  sellerUrl(account,formUrl);if(account.site!=='auctions'||!/\/show\/submit$/.test(new URL(formUrl).pathname))throw Error('出品入力画面ではありません');
  const {categoryId}=await execute(resolveYahooCategory,target);const next=new URL(formUrl);next.searchParams.set('category',categoryId);await go(next.href);
  const structure=await execute(readSellerStructure,null);if(!structure.fileInputs?.length)throw Error('カテゴリ指定後の出品入力画面を確認できません');categoryResolution={target,url:last};return true;
 }
 return {go,loaded,buyerReceiptPreflight:args=>execute(yahooReceiptPage,{...args,action:'preflight',reportErrors:true}),buyerTodo:args=>execute(readBuyerTodoState,args),advanceList:()=>execute(advanceSellerList,null),structure:()=>execute(readSellerStructure,null),
  feedback:args=>execute(account.site==='mercari'?mercariSellerFeedback:yahooSellerFeedback,args),
  feedbackGo:async url=>{if(last!==url)await go(url);},
  preserveForReview:()=>{preserveFeedback=true;},
  feedbackStructure:async({itemId,url})=>{await go(url);return execute(yahooSellerRating,{itemId,action:'inspect'});},
  feedbackWorkflow:async args=>{const {beforePublish,...pageArgs}=args;const proof=await execute(yahooSellerFeedback,pageArgs);if(!proof.ready)throw Error('落札者評価の受取完了を確認できません');await go(proof.ratingUrl);const prepared=await execute(yahooSellerRating,{...pageArgs,action:'prepare'});if(!prepared.prepared)throw Error('新規の落札者評価ではありません');await pause(350);await loaded();const check=await execute(yahooSellerRating,{...pageArgs,action:'preflight',comment:prepared.comment});if(!check.ready)throw Error('評価内容を確認できません');await beforePublish();const notBefore=Date.now(),sent=await execute(yahooSellerRating,{...pageArgs,beforePublish:undefined,action:'submit',comment:prepared.comment});if(!sent.submitRequested)throw Error('評価送信を確認できません');await pause(350);await loaded();await go(proof.ratingUrl);const result=await execute(yahooSellerRating,{...pageArgs,beforePublish:undefined,action:'verify',comment:prepared.comment,notBefore});if(!result.success)throw Error('公開済み評価を確認できません');return result;},
  inspectAuctionOptions:async()=>{const selected=await execute(function(){if(location.hostname!=='auctions.yahoo.co.jp'||!/\/show\/submit$/.test(location.pathname))throw Error('出品入力画面ではありません');const radio=document.querySelector('input[name="salesmode"][value="auction"]');if(!radio||radio.disabled)throw Error('オークション形式を確認できません');if(!radio.checked)radio.click();return radio.checked;},null);if(!selected)throw Error('オークション形式を確認できません');await pause(500);return true;},
  categoryFormFromResults:categoryForm,
  prepareCategory:async target=>{
   const formUrl=last;if(account.site!=='auctions'||!/\/show\/submit$/.test(new URL(formUrl).pathname))throw Error('出品入力画面ではありません');
   if(!await finishChoice(await execute(clickSellerChoice,'category'),'category')||!await finishChoice(await execute(clickSellerChoice,'category-search'),'category-search'))throw Error('カテゴリ検索の入口を確認できません');
   const parts=String(target).split(/\s*[>＞]\s*/).filter(Boolean);await finishChoice(await execute(searchSellerCategory,parts.length>1?parts.at(-2):parts[0]));
   return categoryForm(target,formUrl);
  },
  prepareListingChoices:async job=>{if(account.site!=='mercari')throw Error('メルカリの出品設定ではありません');await execute(sellerDomOperation,{job,phase:'prepare_listing_payer',reportErrors:true});for(const [kind,value] of [['category',job.payload.listingCategory||job.payload.category],['condition',job.payload.condition],['shipping',job.payload.shippingMethod]]){if(await execute(mercariListingChoiceSelected,{kind,value}))continue;if(!await finishChoice(await execute(clickSellerChoice,kind),kind))throw Error('出品条件の選択画面を開けません：'+kind);if(kind==='category')await finishChoice(await execute(searchSellerCategory,value));await finishChoice(await execute(selectMercariListingChoice,{kind,value}),kind==='category'?'listing-category-return':'listing-form');if(kind==='category'){const back=await execute(returnMercariListingForm,null);if(back)await finishChoice(back,'listing-form');}}listingChoices={id:job.id,values:JSON.stringify([job.payload.listingCategory||job.payload.category,job.payload.condition,job.payload.shippingMethod]),url:last};},
  searchCategory:async term=>finishChoice(await execute(searchSellerCategory,term)),
  inspectChoice:async kind=>{
   return finishChoice(await execute(clickSellerChoice,kind),kind);
  },
  inspectionTarget:serial=>execute(readInspectionTarget,serial),
  inspectionShippingTarget:target=>execute(readShippingInspectionTarget,target),
  prepareShipping:async job=>{if(account.site!=='mercari'||!await finishChoice(await execute(clickSellerChoice,'shipping-details'),'shipping-details'))throw Error('配送サイズの選択画面を確認できません');await finishChoice(await execute(advanceMercariShippingSize,{itemId:job.external_id,size:job.payload.size,shippingMethod:job.payload.shippingMethod}),'shipping-place');await finishChoice(await execute(advanceMercariShippingPlace,{itemId:job.external_id,dropoff:job.payload.dropoff}),'shipping-code-ready');},
  inspectionTrades:()=>execute(function(){return [...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length&&/^(取引ナビ|取引画面|取引情報|取引連絡|発送する)$/.test(a.innerText.trim())).map(a=>({url:a.href})).filter((entry,index,all)=>all.findIndex(other=>other.url===entry.url)===index).slice(0,20);},null),
  links:async()=> (await raw()).links.map(link=>{const u=new URL(link.url);return u.hostname==='salesmanagement.yahoo.co.jp'&&u.pathname==='/list'&&/^売上金管理(?:\s+Yahoo!かんたん決済)?$/.test(link.text)?{...link,text:'売上金管理'}:link;}).filter(link=>/^(出品した商品|出品一覧|出品中|取引中|売却済み|出品終了分|売上金管理|落札者なし|出品|出品する|出品フォーム)$/.test(link.text)),
  read:phase=>execute(readSellerPage,{site:account.site,phase,reportErrors:true}),
  selectTab:async label=>{const result=await paceNavigation(()=>execute(clickSellerListTab,label));if(!result)return false;if(result.changing){await pause(350);await loaded();}return true;},
  auctionDetail:async id=>{if(account.site!=='auctions'||!/^[a-z][0-9]+$/i.test(id))throw Error('対象の商品IDを確認できません');await go('https://page.auctions.yahoo.co.jp/jp/auction/'+id);let page=await raw();if(!/(?:終了日時|落札日時|終了日)\s*[:：]?\s*20[0-9]{2}/.test(page.text)){const links=page.links.filter(link=>{try{const u=new URL(link.url);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname==='contact.auctions.yahoo.co.jp'&&u.pathname==='/seller/top'&&[...u.searchParams.values()].includes(id)&&/取引ナビ/.test(link.text);}catch{return false;}});if(links.length===1){await go(links[0].url);page=await raw();}}return page;},
  detail:async(url,id)=>{if(account.site==='mercari'&&!/^m[0-9]+$/.test(id))throw Error('対象の商品IDを確認できません');await go(account.site==='mercari'?'https://jp.mercari.com/transaction/'+id:url);let page=account.site==='mercari'?await execute(readMercariTransactionPage,{id}):await raw();if(!/取引画面|取引情報|受け取り明細/.test(page.text)){const options=page.links.filter(link=>/取引画面|取引ナビ|取引情報|詳細/.test(link.text)&&link.url.includes(id));if(options.length!==1)throw Error('販売明細へのリンクを特定できません');await go(options[0].url);page=await raw();}if(!page.text.includes(id))throw Error('取引の商品IDを確認できません');return page;},
  outboundReceipt:job=>execute(readOutboundReceipt,job),
  parseCarrierReceipts:args=>execute(parseCarrierReceipts,args),
  operation:(job,phase,extra={})=>(['publish','publish_confirmation'].includes(phase)?paceNavigation:action=>action())(async()=>{await loaded();const result=await execute(sellerDomOperation,{job,phase,...extra,reportErrors:true,choicesResolved:listingChoices?.id===job.id&&listingChoices?.values===JSON.stringify([job.payload?.listingCategory||job.payload?.category,job.payload?.condition,job.payload?.shippingMethod])&&listingChoices?.url===last,categoryResolved:categoryResolution?.target===(job.payload?.listingCategory||job.payload?.category)&&categoryResolution?.url===last});if(phase==='read_shipping_code'&&result.qr_code){try{result.shipping_receipt=await execute(readOutboundReceipt,job);}catch{}}return result;}),
  close:()=>preserveFeedback?Promise.resolve():restoreSiteTab(tabs,borrowed).catch(()=>{}),
 };
}

/** Retry a read-only list once after a paced delay, never auth errors or sends. */
export async function readSellerListWithRecovery({site,read,reload,wait=pause}){try{return await read();}catch(error){if(site!=='mercari'||!error.message.includes('出品商品の読み込みが完了していません'))throw error;await wait(8000);await reload();return read();}}
