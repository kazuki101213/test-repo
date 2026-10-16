import {readSellerStructure,readInspectionTarget,readShippingInspectionTarget} from './seller-inspection.js?v=0.1.91';
import {sellerScheduleReady,sellerAccounts,sellerUrl,sellerTarget,readSellerPage,parseSellerSaleDetail} from './seller-sync.js?v=0.1.91';
import {borrowSiteTab,restoreSiteTab} from './existing-tabs.js';
import {sellerDomOperation} from './seller-dom.js?v=0.1.91';
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
 while(Date.now()<end){candidates=[...document.querySelectorAll('a,button,input[type="button"]')].filter(e=>e.getClientRects().length&&(names[kind].some(name=>norm(name)===norm(e.innerText||e.getAttribute('aria-label')||e.value))||(kind==='category'&&e.id==='acMdCateChange')||shippingEdit(e)));if(candidates.length)break;await new Promise(resolve=>setTimeout(resolve,250));}
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
  if(kind==='category')return [...document.querySelectorAll('input')].some(e=>visible(e)&&/カテゴリー名を検索/.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));
  if(kind==='condition')return [...document.querySelectorAll('[data-testid^="condition-"]')].some(visible);
  if(kind==='shipping-details')return location.pathname.startsWith('/transaction/')&&[...document.querySelectorAll('[role=dialog],select,input[type=radio]')].some(visible);
  if(kind==='shipping-place')return location.pathname.startsWith('/transaction/')&&[...document.querySelectorAll('h1,h2,h3')].some(e=>visible(e)&&/発送場所/.test(e.innerText));
  if(kind==='shipping-code-ready')return /^\/transaction\/m[0-9]+$/.test(location.pathname)&&[...document.querySelectorAll('button')].some(e=>visible(e)&&['配送用の2次元コードを表示する','配送用QRコードを表示','2次元コードを発行する','QRコードを表示','発送用QRコードを発行'].includes(e.innerText.trim()));
  if(kind==='shipping')return [...document.querySelectorAll('input[name="selectedShippingMethod"]')].some(visible);
 }else if(location.hostname==='auctions.yahoo.co.jp'){
  if(kind==='category')return /\/show\/topsubmit$/.test(location.pathname)&&[...document.querySelectorAll('a')].some(e=>visible(e)&&/キーワードから選択する/.test(e.innerText));
  if(kind==='category-search')return visible(document.querySelector('#category-search-keyword'));
 }return false;
}
/** Advance only the size step, never the place confirmation or QR issuance. */
export function advanceMercariShippingSize({itemId,size,shippingMethod='らくらくメルカリ便'}){
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId+'/shipping_class'||!/^m[0-9]{8,14}$/.test(itemId))throw Error('対象取引のサイズ選択画面ではありません');
 const norm=s=>String(s||'').replace(/\s/g,'').replace(/[〜～−–]/g,'-'),visible=e=>e.getClientRects().length>0;
 const wanted=['100','140'].includes(String(size))?shippingMethod==='らくらくメルカリ便'?'宅急便60-160':shippingMethod==='ゆうゆうメルカリ便'?'ゆうパック':null:['宅急便コンパクト','ゆうパケットプラス','ゆうパケット'].includes(size)?size:null;if(!wanted)throw Error('配送サイズを確認できません');
 const radios=[...document.querySelectorAll('input[type=radio]')].filter(e=>visible(e)&&!e.disabled&&(norm(e.value)===wanted||wanted==='ゆうパック'&&/^ゆうパック60-170$/.test(norm(e.value))));
 const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.innerText.trim()==='選択して次へ');if(radios.length!==1||buttons.length!==1)throw Error('サイズ選択の項目を1件に確認できません');
 const before={url:location.href,text:document.body.innerText,controls:''};if(!radios[0].checked)radios[0].click();if(!radios[0].checked)throw Error('サイズ選択を確認できません');setTimeout(()=>buttons[0].click(),100);return before;
}
/** Called only for an app-requested shipping operation, not a display inspection. */
export function advanceMercariShippingPlace({itemId,dropoff}){
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId+'/shipping_facilities'||!/^m[0-9]{8,14}$/.test(itemId))throw Error('対象取引の発送場所選択画面ではありません');
 const visible=e=>e.getClientRects().length>0,norm=s=>String(s||'').replace(/[\s\-−–]/g,'');
 const values={'セブンイレブン':'SEVEN_ELEVEN','ヤマト営業所':'YAMATO_OFFICE'},postal={'ローソン':'ローソン','郵便局':'郵便局'};
 const wanted=values[dropoff],label=postal[dropoff];if(!wanted&&!label)throw Error('発送場所を確認できません');
 const radios=[...document.querySelectorAll('input[type=radio]')].filter(e=>visible(e)&&!e.disabled&&(wanted?e.value===wanted:norm([...e.labels].map(l=>l.innerText).join(''))===label));
 const buttons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.innerText.trim()==='選択して完了する');if(radios.length!==1||buttons.length!==1)throw Error('発送場所の選択肢を1件に確認できません');
 const before={url:location.href,text:document.body.innerText,controls:''};if(!radios[0].checked)radios[0].click();if(!radios[0].checked)throw Error('発送場所の選択を確認できません');setTimeout(()=>buttons[0].click(),100);return before;
}
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
   const entry=await session.structure();if(!entry.fileInputs?.length){const direct=(await session.links()).filter(link=>/^(出品|出品する|出品フォーム)$/.test(link.text)&&link.url!==listing.url);if(direct.length!==1)throw Error('出品入力画面への実リンクを1件に確認できません');await session.go(direct[0].url);}
   await session.operation(job,'listing_preflight');
   if(account.site==='auctions')await session.prepareCategory(job.payload.listingCategory||job.payload.category);
   const files=[];let total=0,convertedTotal=0;for(const [index,url] of job.payload.photos.entries()){
    const source=new URL(url);if(source.protocol!=='https:'||!['xgoppuqoqeppckyunnvx.supabase.co','lh3.googleusercontent.com','drive.google.com','drive.usercontent.google.com','drive.googleusercontent.com'].includes(source.hostname))throw Error('写真の取得先を確認できません');
    const response=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('写真を取得できません');const blob=await response.blob();if(!['image/jpeg','image/png','image/webp'].includes(blob.type)||blob.size>8*1024*1024)throw Error('写真の形式・容量を確認してください');total+=blob.size;if(total>20*1024*1024)throw Error('出品写真の合計容量が20MBを超えています');const photo=await normalizeSellerPhoto({site:account.site,file:{name:`photo-${index+1}.`+(blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg'),type:blob.type,bytes:[...new Uint8Array(await blob.arrayBuffer())]}});convertedTotal+=photo.bytes.length;if(convertedTotal>20*1024*1024)throw Error('変換後の出品写真の合計容量が20MBを超えています');files.push(photo);
   }
   await session.operation(job,'prepare_listing',{files});
   // Persisting the claim precedes the only publish attempt. A timeout is uncertain, never retried.
   mutating=true;let sent=await session.operation(job,'publish');
   if(sent.confirmation){await session.loaded();sent=await session.operation(job,'publish_confirmation');}
   await session.loaded();const listingResult=await session.operation(job,'listing_result');result=listingResult;
  }else{
   if(!job.url)throw Error('取引URLを取得できません');await session.go(job.url);
   let shippingPrepared=false;
   if(job.kind==='shipping_code'&&account.site==='mercari'&&session.prepareShipping){const preflight=await session.operation(job,'shipping_preflight');if(preflight.needsEditor){mutating=true;await session.prepareShipping(job);shippingPrepared=true;}else if(preflight.readyForCode){if(preflight.configuredDropoff!==job.payload.dropoff)throw Error('サイトの発送場所がアプリ設定と一致しません');shippingPrepared=true;}}
   mutating=['register_package','ship_notice','message_send','shipping_code'].includes(job.kind);
   result=await session.operation(job,job.kind,{shippingPrepared});
   if(job.kind==='shipping_code'&&result.code_requested){await session.loaded();result=await session.operation(job,'read_shipping_code',{waitForShippingCode:true});}
  }
  status='succeeded';
 }catch(error){status=mutating?'uncertain':'failed';result={note:error.message};await log('error','販売サイトの操作を停止しました。自動再送はしません：'+error.message);}
 finally{await session?.close();}
 await rpc('extension_finish_seller_operation',{p_id:job.id,p_status:status,p_result:result});
}
export async function openSellerSession(account,{tabs,scripting,windows,identity,executionTimeoutMs=30000}){
 const borrowed=await borrowSiteTab(tabs,account.site);let last=borrowed.originalUrl,categoryResolution=null;
 async function loaded(){for(let n=0;n<60;n++){const tab=await tabs.get(borrowed.id);if(tab.status==='complete'){await pause(800);const settled=await tabs.get(borrowed.id);if(settled.status==='complete'&&settled.url===tab.url){sellerUrl(account,settled.url);last=settled.url;borrowed.lastUrl=last;return;}}await pause(300);}throw Error('販売画面の読み込みが時間切れになりました');}
 async function go(url){sellerUrl(account,url);const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('画面のURLが変更されたため停止しました');const arrived=await tabs.update(borrowed.id,{url,active:account.site==='mercari'});last=url;borrowed.lastUrl=url;if(account.site==='mercari'&&windows&&Number.isInteger(arrived.windowId)){const w=await windows.get(arrived.windowId);if(w.state==='minimized')await windows.update(w.id,{state:'normal'});if(w.state!=='maximized'&&(w.width<1000||w.height<700))await windows.update(w.id,{width:1200,height:900});await windows.update(w.id,{focused:true});}await loaded();}
 async function execute(func,args){
  const current=await tabs.get(borrowed.id);if(current.url!==last)throw Error('画面のURLが変更されたため停止しました');let timer;
  try{
   const timeout=args?.phase==='prepare_listing'?Math.max(executionTimeoutMs,120000):func===readSellerPage&&executionTimeoutMs===30000?60000:executionTimeoutMs;
   const results=await Promise.race([scripting.executeScript({target:{tabId:borrowed.id},func,args:[args]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('販売画面の確認が時間切れになりました。自動再試行しません')),timeout);})]);
   if(results[0]?.result==null)throw Error('販売画面から結果を取得できません');if(results[0]?.result?.__error)throw Error(results[0].result.__error);return results[0]?.result;
  }finally{clearTimeout(timer);}
 }
 try{await go(account.identity.pageUrl||account.listUrl);const verified=await identity(borrowed.id,account);if(verified?.confirmed!==true)throw Error('出品アカウントを確認できません');}catch(error){await restoreSiteTab(tabs,borrowed).catch(()=>{});throw error;}
 const raw=()=>execute(function(){const text=document.body.innerText;if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|ロボットではない|認証コードを入力/.test(text))throw Error('追加認証が必要です');return {text,url:location.href,links:[...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length).map(a=>({text:a.innerText.trim(),url:a.href}))};},null);
 async function finishChoice(before,kind=null){if(!before)return false;await pause(350);await loaded();const end=Date.now()+15000;while(Date.now()<end){if(kind?await execute(sellerChoiceReady,kind):await execute(function(before){return location.href!==before.url||document.body.innerText!==before.text||[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>[e.id,e.name,e.type].join('|')).join(';')!==before.controls;},before))return true;await pause(250);await loaded();}throw Error('選択画面の表示を確認できません。再試行しません');}
 async function categoryForm(target,formUrl){
  sellerUrl(account,formUrl);if(account.site!=='auctions'||!/\/show\/submit$/.test(new URL(formUrl).pathname))throw Error('出品入力画面ではありません');
  const {categoryId}=await execute(resolveYahooCategory,target);const next=new URL(formUrl);next.searchParams.set('category',categoryId);await go(next.href);
  const structure=await execute(readSellerStructure,null);if(!structure.fileInputs?.length)throw Error('カテゴリ指定後の出品入力画面を確認できません');categoryResolution={target,url:last};return true;
 }
 return {go,loaded,structure:()=>execute(readSellerStructure,null),
  inspectAuctionOptions:async()=>{const selected=await execute(function(){if(location.hostname!=='auctions.yahoo.co.jp'||!/\/show\/submit$/.test(location.pathname))throw Error('出品入力画面ではありません');const radio=document.querySelector('input[name="salesmode"][value="auction"]');if(!radio||radio.disabled)throw Error('オークション形式を確認できません');if(!radio.checked)radio.click();return radio.checked;},null);if(!selected)throw Error('オークション形式を確認できません');await pause(500);return true;},
  categoryFormFromResults:categoryForm,
  prepareCategory:async target=>{
   const formUrl=last;if(account.site!=='auctions'||!/\/show\/submit$/.test(new URL(formUrl).pathname))throw Error('出品入力画面ではありません');
   if(!await finishChoice(await execute(clickSellerChoice,'category'),'category')||!await finishChoice(await execute(clickSellerChoice,'category-search'),'category-search'))throw Error('カテゴリ検索の入口を確認できません');
   const parts=String(target).split(/\s*[>＞]\s*/).filter(Boolean);await finishChoice(await execute(searchSellerCategory,parts.length>1?parts.at(-2):parts[0]));
   return categoryForm(target,formUrl);
  },
  searchCategory:async term=>finishChoice(await execute(searchSellerCategory,term)),
  inspectChoice:async kind=>{
   return finishChoice(await execute(clickSellerChoice,kind),kind);
  },
  inspectionTarget:serial=>execute(readInspectionTarget,serial),
  inspectionShippingTarget:target=>execute(readShippingInspectionTarget,target),
  prepareShipping:async job=>{if(account.site!=='mercari'||!await finishChoice(await execute(clickSellerChoice,'shipping-details'),'shipping-details'))throw Error('配送サイズの選択画面を確認できません');await finishChoice(await execute(advanceMercariShippingSize,{itemId:job.external_id,size:job.payload.size,shippingMethod:job.payload.shippingMethod}),'shipping-place');await finishChoice(await execute(advanceMercariShippingPlace,{itemId:job.external_id,dropoff:job.payload.dropoff}),'shipping-code-ready');},
  inspectionTrades:()=>execute(function(){return [...document.querySelectorAll('a[href]')].filter(a=>a.getClientRects().length&&/^(取引ナビ|取引画面|取引情報|取引連絡|発送する)$/.test(a.innerText.trim())).map(a=>({url:a.href})).filter((entry,index,all)=>all.findIndex(other=>other.url===entry.url)===index).slice(0,20);},null),
  links:async()=> (await raw()).links.filter(link=>/^(出品した商品|出品一覧|出品中|取引中|売却済み|出品終了分|売上金管理|出品|出品する|出品フォーム)$/.test(link.text)),
  read:phase=>execute(readSellerPage,{site:account.site,phase}),
  selectTab:label=>execute(async function(label){const candidates=[...document.querySelectorAll('button,[role="tab"]')].filter(e=>e.getClientRects().length&&e.innerText.trim()===label);if(candidates.length!==1)return false;const before=document.body.innerText;const button=candidates[0];button.click();for(let n=0;n<20;n++){await new Promise(resolve=>setTimeout(resolve,200));if(button.getAttribute('aria-selected')==='true'||document.body.innerText!==before)return true;}throw Error('一覧タブの切り替え結果を確認できません');},label),
  detail:async(url,id)=>{await go(url);let page=await raw();if(!/取引画面|取引情報|受け取り明細/.test(page.text)){const options=page.links.filter(link=>/取引画面|取引ナビ|取引情報|詳細/.test(link.text)&&link.url.includes(id));if(options.length!==1)throw Error('販売明細へのリンクを特定できません');await go(options[0].url);page=await raw();}if(!page.text.includes(id))throw Error('取引の商品IDを確認できません');return page;},
  operation:(job,phase,extra={})=>execute(sellerDomOperation,{job,phase,...extra,categoryResolved:categoryResolution?.target===(job.payload?.listingCategory||job.payload?.category)&&categoryResolution?.url===last}),
  close:()=>restoreSiteTab(tabs,borrowed).catch(()=>{}),
 };
}
