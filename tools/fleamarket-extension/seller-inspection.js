import {parseSellerSaleDetail} from './seller-sync.js?v=0.1.121';
const PROFILE_ACCOUNTS={
 'ba92b386-e0bc-48be-b3b6-ca9550fa1a2d':'auctions-1',
 'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':'mercari-1',
 '51502a66-28a6-4af0-81ea-660e63d8b66c':'mercari-2',
};
const PROFILE_SALES={'ba92b386-e0bc-48be-b3b6-ca9550fa1a2d':['auctions-1'],'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':['mercari-1','auctions-2'],'51502a66-28a6-4af0-81ea-660e63d8b66c':['mercari-2']};
export function sellerInspectionApplies(request,profileId,previous,now=Date.now()){
 if(!request||!PROFILE_ACCOUNTS[profileId]||request.id===previous||!/^[-0-9a-f]{36}$/i.test(request.id||''))return false;
 if(request.advanceShippingSize!=null||request.issueShippingQr!=null||request.listingPreview!=null||request.readListingShippingOnly!=null)return false;
 if(request.saleEvidenceLimit!=null&&(!request.saleEvidence||!Number.isInteger(request.saleEvidenceLimit)||request.saleEvidenceLimit<1||request.saleEvidenceLimit>40))return false;
 if(request.saleEvidence!=null&&(request.saleEvidence!==true||request.sellerListsOnly!==true||!request.accountId))return false;
 if(request.accountId!=null&&(!request.sellerListsOnly||!PROFILE_SALES[profileId]?.includes(request.accountId)))return false;
 if(request.sellerListsOnly!=null&&(request.sellerListsOnly!==true||!request.accountId&&profileId!=='ba92b386-e0bc-48be-b3b6-ca9550fa1a2d'))return false;
 const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt);
 if(request.readShippingQrOnly!=null&&(request.readShippingQrOnly!==true||profileId!=='51502a66-28a6-4af0-81ea-660e63d8b66c'||request.targetSerial!=='1805a'||request.targetItemId!=='m99125688368'))return false;
 return request.kind==='seller-readonly-structure'&&(profileId!=='51502a66-28a6-4af0-81ea-660e63d8b66c'||!!request.targetItemId||request.sellerListsOnly===true)&&(request.targetSerial==null||/^[0-9]{1,8}[a-z]{0,3}$/.test(request.targetSerial))&&(request.targetItemId==null||/^m[0-9]{8,14}$/.test(request.targetItemId)&&!!request.targetSerial&&['f29f12b6-35f2-4e9f-8312-a8321ddf3c12','51502a66-28a6-4af0-81ea-660e63d8b66c'].includes(profileId))&&Array.isArray(request.profiles)&&request.profiles.includes(profileId)&&request.profiles.every(id=>!!PROFILE_ACCOUNTS[id])&&Number.isFinite(issued)&&Number.isFinite(expires)&&issued<=now&&expires>now&&expires-issued<=15*60000;
}
/** Only public item IDs, financial labels and dates; never page text, buyer data or credentials. */
export function saleDetailEvidence(site,row,page){
 const text=page.text.replace(/\s+/g,' ').trim(),url=new URL(page.url);
 const ids=[...text.matchAll(/商品ID\s*[:：]?\s*([a-z][0-9]+)/gi)].map(m=>m[1].toLowerCase());
 const result={external_id:row.external_id,serial:row.serial,source:url.origin+url.pathname,productIds:ids,amounts:{},dates:[]};
 for(const label of ['商品代金','販売利益','決済金額','受取金額'])result.amounts[label]=[...text.matchAll(new RegExp(label+'\\s*[:：]?\\s*[¥￥]?\\s*([0-9][0-9,]*)\\s*(?:円)?','g'))].map(m=>Number(m[1].replaceAll(',',''))).slice(0,4);
 result.dates=[...text.matchAll(/(?:購入日時|取引日)\s*[:：]?\s*(20[0-9]{2})[年/.-]\s*([0-9]{1,2})[月/.-]\s*([0-9]{1,2})/g)].map(m=>m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')).slice(0,4);
 try{result.parsed=parseSellerSaleDetail(site==='mercari'?'メルカリ':'ヤフオク',text,row.external_id,page.url);}catch(error){result.parseError=error.message;}
 result.sourceItemMatches=[...url.searchParams.values()].includes(row.external_id);result.sourceQueryKeys=[...url.searchParams.keys()];result.dateFragments=[...text.matchAll(/(開始日時|終了日時|落札日時|落札日|終了日|取引日)\s*[:：]?\s*([0-9０-９年月日時分秒月火水木金土日（日）()：:/.\s-]{1,65})/g)].map(m=>({label:m[1],value:m[2].trim()})).slice(0,8);result.dateTokens=[...text.matchAll(/20[0-9]{2}\s*[年/.\-]\s*[0-9]{1,2}\s*[月/.\-]\s*[0-9]{1,2}/g)].map(m=>m[0]).slice(0,8);result.dateLabels=['開始日時','終了日時','落札日時','終了日','落札日','取引日'].filter(label=>text.includes(label));result.dateFields=[];
 for(const label of ['購入日時','取引日','取引日時','落札日時','終了日時','落札日','終了日','支払日','取扱日','決済日','入金日']){const found=[...text.matchAll(new RegExp(label+'\\s*[:：]?\\s*(20[0-9]{2})[年/.-]\\s*([0-9]{1,2})[月/.-]\\s*([0-9]{1,2})(?:日)?(?:\\s+([0-9]{1,2})[:：]([0-9]{2}))?','g'))];for(const m of found.slice(0,4))result.dateFields.push({label,date:m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')});}
 result.detailLinks=(page.links||[]).filter(l=>/取引画面|取引ナビ|取引情報|商品ページ/.test(l.text)).map(l=>{const u=new URL(l.url);return{label:l.text.slice(0,20),host:u.hostname,path:u.pathname,itemMatches:l.url.includes(row.external_id)};}).slice(0,8);
 return result;
}
/** User-supplied item ID: exact transaction and serial checks, no form entry or clicks. */
export async function readShippingInspectionTarget({serial,itemId}){
 if(!/^[0-9]{1,8}[a-z]{0,3}$/.test(serial)||!/^m[0-9]{8,14}$/.test(itemId)||location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId)return {__error:'指定した商品の取引画面ではありません'};
 const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden',norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const end=Date.now()+18000;let root,body,serials=[];
 do{root=document.body;body=norm(root.innerText);if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/ログインしてください|セキュリティチェック|文字認証/.test(body))return {__error:'ログイン・追加認証のため停止しました'};const productText=body+' '+[...root.querySelectorAll('img[alt]')].filter(visible).map(e=>e.alt).join(' ');serials=[...productText.matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());if(serials.includes(serial)&&/取引画面|取引情報|発送|配送/.test(body))break;await new Promise(resolve=>setTimeout(resolve,250));}while(Date.now()<end);
 const serialMatches=serials.includes(serial);
 const sellerShipping=/発送してください|発送して下さい|商品の発送をお願いします|発送通知をする|商品の発送を通知|発送したことを通知|発送場所を選択|配送用の2次元コード/.test(body);
 const buyerControls=/商品の到着をお待ち|商品が届いたら|受取評価をする|受け取り評価をする/.test(body);
 return {itemId,serial,serialMatches,visibility:document.visibilityState,visibleTextLength:body.length,mainCount:document.querySelectorAll('main').length,loadingMarkers:[...root.querySelectorAll('[data-testid]')].filter(e=>visible(e)&&/skeleton|loading|error|empty/i.test(e.getAttribute('data-testid'))).map(e=>e.getAttribute('data-testid')).slice(0,20),sellerShipping,buyerControls,paymentWaiting:/支払い待ち|支払いをお待ち|お支払い待ち/.test(body),statusPhrases:['発送してください','発送して下さい','発送通知をする','配送方法を選択してください','取引が完了しました','発送済み','配送中','アプリで開く','アプリで取引','ページが見つかりません','表示できません','読み込み中'].filter(t=>body.includes(t)),codeElements:[...root.querySelectorAll('canvas,img')].filter(e=>visible(e)&&/QR|2次元|二次元|配送コード/.test(e.getAttribute('alt')||e.getAttribute('aria-label')||e.id||'')).map(e=>({tag:e.tagName,id:e.id||null,testId:e.getAttribute('data-testid'),alt:e.getAttribute('alt')?.slice(0,80),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,naturalWidth:e.naturalWidth,complete:e.complete,withinMain:!!e.closest('main'),sourceHost:(()=>{try{return new URL(e.getAttribute('src'),location.href).hostname;}catch{return null;}})(),format:e.tagName==='CANVAS'?'canvas':e.getAttribute('src')?.startsWith('data:')?'data':e.getAttribute('src')?.startsWith('blob:')?'blob':'url'}))};
}
/** Exact visible serial match only. No buyer names, input values or unrelated product text. */
export function readInspectionTarget(serial){
 if(!/^[0-9]{1,8}[a-z]{0,3}$/.test(serial)||location.hostname!=='jp.mercari.com'||!location.pathname.startsWith('/mypage/listings'))throw Error('対象の出品一覧ではありません');
 const visible=e=>e.getClientRects().length>0,norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const anchors=[...document.querySelectorAll('a[href]')].filter(visible),matches=[];
 for(const a of anchors){let box=a;for(let n=0;n<4&&box;n++,box=box.parentElement){const text=norm(box.innerText+' '+[...box.querySelectorAll('img[alt]')].map(e=>e.alt).join(' '));const ids=[...text.matchAll(/[【\[]([0-9]+[a-z]*)[】\]]/gi)].map(m=>m[1].toLowerCase());if(ids.length&&ids.every(id=>id===serial)){const u=new URL(a.href);if(u.hostname==='jp.mercari.com'&&/^\/(?:item|transaction)\/m[0-9]+/.test(u.pathname))matches.push({url:u.href,serial,shippingPending:/発送してください|発送して下さい|発送待ち/.test(text)});}if(new Set(ids).size>1)break;}}
 const unique=matches.filter((m,i,all)=>all.findIndex(x=>x.url===m.url)===i).map(m=>({...m,shippingPending:matches.some(x=>x.url===m.url&&x.shippingPending)}));
 const targetRe=new RegExp('[【\\[]'+serial+'[】\\]]','i');const body=document.body.innerText;const markers=[...document.querySelectorAll('[data-testid]')].filter(visible).map(e=>e.getAttribute('data-testid')).filter(t=>/item|list|loading|error|empty|progress/i.test(t));
 return {targetInVisibleText:targetRe.test(body),statePhrases:['発送してください','発送して下さい','取引中の商品はありません','出品した商品がありません','商品はまだありません','商品がありません','読み込み中','エラーが発生'].filter(t=>body.includes(t)),busyNodes:document.querySelectorAll('[aria-busy=true]').length,visibleListMarkers:[...new Set(markers)].slice(0,50),visibleFrames:[...document.querySelectorAll('iframe')].filter(visible).length,matches:unique,visibleAnchors:anchors.length,visibleItemLinks:anchors.filter(a=>/\/(?:item|transaction)\/m[0-9]+/.test(a.href)).length,targetVisible:[...document.querySelectorAll('img[alt]')].some(e=>visible(e)&&new RegExp('[【\\[]'+serial+'[】\\]]','i').test(e.alt)),navigation:anchors.filter(a=>/^(出品中|取引中|売却済み)$/.test(norm(a.innerText))).map(a=>({text:norm(a.innerText),url:a.href})),listControls:[...document.querySelectorAll('button,[role=tab]')].filter(visible).map(e=>norm(e.innerText)).filter(t=>/^(出品中|取引中|売却済み|もっと見る|次へ)$/.test(t))};
}
/** Fixed diagnostic: returns control structure, never field values, cookies or page HTML. */
export async function readSellerStructure(){
 const norm=value=>(value||'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const u=new URL(location.href);const pageRoot=()=>u.hostname==='jp.mercari.com'&&u.pathname.startsWith('/transaction/')?document.body:document.querySelector('main')||document.body;let root=pageRoot();
 const end=Date.now()+10000;while(Date.now()<end){root=pageRoot();const t=norm(root.innerText);const ready=u.hostname==='jp.mercari.com'&&u.pathname==='/mypage/listings'?/出品した商品|出品中|取引中|売却済み/.test(t):u.pathname.includes('/sell/create')?!!root.querySelector('input[type="file"],input[name="name"],textarea'):!!t;
  if(ready&&!root.querySelector('[aria-busy="true"]'))break;await new Promise(resolve=>setTimeout(resolve,250));}
 const body=norm(root.innerText);
 if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|認証コードを入力|ロボットではない|セキュリティチェック|ログインしてください/.test(body))throw Error('ログイン・追加認証のため診断を停止しました');
 const label=e=>norm([e.getAttribute('aria-label'),...(e.labels?[...e.labels].map(l=>l.innerText):[]),...(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.innerText),e.getAttribute('placeholder')].filter(Boolean).join(' ')).slice(0,120);
 const recognized=/出品|取引|配送|発送|商品|写真|画像|カテゴリー|カテゴリ|価格|説明|状態|送料|サイズ|自動|終了|メッセージ|コード/;
 const selectionPage=/カテゴリ|カテゴリー|商品の状態|配送の方法/.test(norm(root.querySelector('h1,h2,[role="dialog"]')?.innerText));
 if(u.hostname==='jp.mercari.com'&&u.pathname==='/sell/shipping_methods')root=document.body;
 const section=e=>{for(let p=e.parentElement,n=0;p&&n<4;p=p.parentElement,n++){const h=[...p.children].find(c=>/^(H2|H3|H4|LEGEND|DT)$/.test(c.tagName));if(h)return norm(h.innerText).slice(0,100);}return null;};
 const controls=[...root.querySelectorAll('input:not([type="hidden"]),textarea,select,button,a,[role="button"],[role="combobox"],[role="tab"],[contenteditable="true"]')].filter(visible).map(e=>{
  const text=e.matches('button,a,[role="button"],[role="tab"],input[type="button"],input[type="submit"]')?norm(e.innerText||e.getAttribute('aria-label')||e.value).slice(0,100):label(e);
  if(!e.matches('input,textarea,select')&&!text)return null;if(e.tagName==='A'&&!selectionPage&&!/選択|変更|設定|選んで|未設定|出品|取引|配送|発送/.test(text))return null;
  return {tag:e.tagName,type:e.type||null,role:e.getAttribute('role'),name:e.name||null,id:e.id||null,testId:e.getAttribute('data-testid'),section:section(e),label:text,optionValue:e.type==='radio'||e.type==='checkbox'?e.getAttribute('value'):undefined,checked:e.type==='radio'||e.type==='checkbox'?e.checked:undefined,disabled:e.disabled===true,readOnly:e.readOnly===true,ariaHidden:e.getAttribute('aria-hidden'),required:e.required===true,accept:e.type==='file'?e.accept:null,options:e.tagName==='SELECT'?[...e.options].slice(0,60).map(o=>norm(o.text).slice(0,60)):undefined};
 }).filter(Boolean).slice(0,100);
 const links=[...root.querySelectorAll('a[href]')].filter(visible).flatMap(e=>{const text=norm(e.innerText);if(!/^(出品|出品する|出品した商品|出品一覧|出品中|取引中|売却済み|出品終了分|売上金管理|取引ナビ|発送する|配送方法を選択する)$/.test(text))return [];try{const x=new URL(e.href);return [{text,host:x.hostname,path:x.pathname,queryKeys:[...x.searchParams.keys()]}];}catch{return [];}}).slice(0,30);
 const notices=[...root.querySelectorAll('p,[role="status"],h2,h3,span')].filter(e=>visible(e)&&!e.children.length).map(e=>norm(e.innerText)).filter(t=>t.length<100&&/商品.*(?:ありません|ない|ございません)|取引.*(?:ありません|ない|ございません)|読み込み中|エラー|発送して|発送待ち|支払い待ち|チャージ完了/.test(t)).slice(0,12);
 return {host:u.hostname,path:u.pathname.replace(/\b(?:m[0-9]{7,}|[a-z][0-9]{8,})\b/gi,'[item]'),queryKeys:[...u.searchParams.keys()],auctionOptionLabels:u.hostname==='auctions.yahoo.co.jp'&&u.pathname==='/sell/jp/show/preview'?[...root.querySelectorAll('span,div,p,li,dt,th')].filter(e=>visible(e)&&/^自動(?:延長|再出品)[：:]?$/.test(norm(e.textContent))).map(e=>({label:norm(e.textContent),next:e.nextElementSibling&&norm(e.nextElementSibling.textContent).length<100?norm(e.nextElementSibling.textContent):null,parent:e.parentElement&&norm(e.parentElement.textContent).length<300?norm(e.parentElement.textContent):null})).slice(0,12):[],validationErrors:[...root.querySelectorAll('.Error,[role=alert]')].filter(visible).map(e=>norm(e.innerText).slice(0,200)).filter(Boolean).slice(0,12),salesLinks:[...document.querySelectorAll('a[href]')].filter(e=>visible(e)&&/売上|受取|受け取り/.test(norm(e.innerText))).map(e=>{const link=new URL(e.href);return {text:norm(e.innerText).slice(0,50),host:link.hostname,path:link.pathname,queryKeys:[...link.searchParams.keys()]};}).slice(0,15),notices,controls,links,headings:[...root.querySelectorAll('h1,h2,h3')].filter(visible).map(e=>norm(e.innerText)).filter(t=>recognized.test(t)&&t.length<80).slice(0,12),fileInputs:[...root.querySelectorAll('input[type="file"]')].map(e=>({accept:e.accept,multiple:e.multiple,disabled:e.disabled,id:e.id||null,name:e.name||null,visible:visible(e),section:section(e),ancestors:(()=>{const rows=[];for(let a=e.parentElement,n=0;a&&n<4;a=a.parentElement,n++)rows.push({tag:a.tagName,id:a.id||null,testId:a.getAttribute('data-testid'),images:a.querySelectorAll('img').length,files:a.querySelectorAll('input[type=file]').length});return rows;})()})),backingFields:[...root.querySelectorAll('select,textarea')].filter(e=>!visible(e)).map(e=>({tag:e.tagName,id:e.id||null,name:e.name||null,section:section(e),options:e.tagName==='SELECT'?[...e.options].slice(0,50).map(o=>norm(o.text)):undefined})).slice(0,30),photoNeighbors:[...root.querySelectorAll('input[type=file]')].map(e=>({id:e.id||null,neighbors:[...(e.parentElement?.parentElement?.children||[])].slice(0,16).map(n=>({tag:n.tagName,id:n.id||null,className:typeof n.className==='string'?n.className.slice(0,120):null,images:n.querySelectorAll('img').length,children:[...n.children].slice(0,8).map(c=>({tag:c.tagName,id:c.id||null,className:typeof c.className==='string'?c.className.slice(0,120):null,images:c.querySelectorAll('img').length}))}))})),photoFields:[...root.querySelectorAll('#ImageUpArea input[type=hidden]')].filter(e=>/image|photo|thumb/i.test(e.name||e.id||'')).map(e=>({name:e.name||null,id:e.id||null,hasValue:!!e.value})).slice(0,30),photoControls:[...root.querySelectorAll('#ImageUpArea img')].map(e=>({id:e.id||null,alt:e.alt||null,visible:visible(e),parentId:e.parentElement?.id||null,sourceKind:e.src.startsWith('blob:')?'blob':e.src.startsWith('data:')?'data':'other',width:e.naturalWidth,height:e.naturalHeight})).slice(0,80),fixedAuctionSettings:[...root.querySelectorAll('input[type=hidden]')].filter(e=>/^(AutoExtend|NumResubmit|AutoRelist|AutoResubmit)$/i.test(e.name||'')).map(e=>({name:e.name,value:/^(true|false|[0-3])$/.test(e.value)?e.value:null})),publicSettings:[...root.querySelectorAll('input[type=checkbox],input[type=radio]')].filter(e=>/auto|extend|relist|自動|延長|再出品/i.test((e.name||'')+' '+(e.id||'')+' '+label(e))).map(e=>({id:e.id||null,name:e.name||null,label:label(e),type:e.type,checked:e.checked,visible:visible(e)})).slice(0,20),editorFrames:[...root.querySelectorAll('iframe')].map(e=>{let editable=false;try{editable=e.contentDocument?.body?.isContentEditable===true;}catch{}return {id:e.id||null,title:e.title||null,editable};}),shippingCodesVisible:!!root.querySelector('canvas[aria-label*="QR"],img[alt*="QR"],img[alt*="2次元"]')};
}
/** Borrow registered tabs once. Only public category search; no listing entry, business submission, RPC writes or new tabs. */
export async function runSellerReadOnlyInspection({settings,profileId,storage,fetchRequest,openSession,log,rpc}){
 const request=await fetchRequest(),previous=(await storage.get('sellerInspectionRequest')).sellerInspectionRequest;
 if(!sellerInspectionApplies(request,profileId,previous))return false;
 const account=settings.accounts.find(a=>a.enabled&&a.id===(request.accountId||PROFILE_ACCOUNTS[profileId]));if(!account)return false;
 const evidence={requestId:request.id,accountId:account.id,at:new Date().toISOString(),pages:[],readOnly:true,adapterRevision:'native-choices-20261016-12'};let session;
 await storage.set({sellerInspectionRequest:request.id,sellerInspectionEvidence:{...evidence,status:'running'}});
 try{
  session=await openSession(account);evidence.choiceInspectionAvailable=typeof session.inspectChoice==='function';evidence.pages.push({kind:'identity',...await session.structure()});
  if(request.targetItemId){
   if(account.site!=='mercari')throw Error('商品ID指定の診断はメルカリのみです');
   await session.go('https://jp.mercari.com/transaction/'+request.targetItemId);
   evidence.target=await session.inspectionShippingTarget({serial:request.targetSerial,itemId:request.targetItemId});
   evidence.pages.push({kind:'target-shipping',...await session.structure()});
   if(evidence.target.serialMatches!==true||!evidence.target.sellerShipping||evidence.target.buyerControls||evidence.target.paymentWaiting)throw Error('指定商品に発送待ちの出品者画面を確認できません');
   if(request.readShippingQrOnly===true){
    const job={external_id:request.targetItemId,trade_key:'inspection:'+request.id,channel:'メルカリ',payload:{}};
    const result=await session.operation(job,'read_shipping_code',{waitForShippingCode:true});evidence.qr={captured:typeof result.qr_code==='string'&&result.qr_code.startsWith('data:image/png;base64,'),format:result.qr_code?'image/png':null,dataLength:result.qr_code?.length||0};evidence.pages.push({kind:'existing-shipping-qr',...await session.structure()});evidence.status=evidence.qr.captured?'completed':'stopped';return true;
   }
   if(session.inspectChoice&&await session.inspectChoice('shipping-details')){
    const choices=await session.structure();evidence.pages.push({kind:'shipping-choices',...choices});
   }
   evidence.status='completed';return true;
  }
  let links=await session.links();
  if(request.sellerListsOnly===true){
   await session.go(account.site==='mercari'?'https://jp.mercari.com/mypage':'https://auctions.yahoo.co.jp/my');
   const menu=await session.links(),seen=new Set(),queue=[],saleRows=[];
   const enqueue=links=>{for(const link of links)if(['出品した商品','出品一覧','出品中','取引中','売却済み','出品終了分','売上金管理'].includes(link.text)&&!seen.has(link.url)&&!queue.some(x=>x.url===link.url))queue.push(link);};
   enqueue(menu);evidence.pages.push({kind:'seller-menu',...await session.structure()});
   for(let n=0;queue.length&&n<7;n++){const link=queue.shift();seen.add(link.url);await session.go(link.url);const phase=['出品した商品','出品一覧'].includes(link.text)?null:link.text;const page=await session.read(phase);if(request.saleEvidence===true)for(const row of page.rows.slice(0,account.site==='auctions'?40:50))if(row.status==='販売済'&&!saleRows.some(old=>old.external_id===row.external_id))saleRows.push(row);const plans=rpc&&page.rows.length?await rpc('seller_observation_plan',{p_account_id:account.id,p_rows:page.rows.slice(0,100)}):[];evidence.pages.push({kind:'seller-list-only',phase:link.text,planCounts:plans.reduce((out,p)=>(out[p.action]=(out[p.action]||0)+1,out),{}),samples:page.rows.slice(0,8).map(({external_id,serial,status})=>({external_id,serial,status})),...await session.structure(),rowCount:page.rows.length,itemCount:page.itemCount,empty:page.empty,active:page.active,statuses:[...new Set(page.rows.map(row=>row.status))],emptyPhrases:[...page.text.matchAll(/[^。]{0,25}(?:ありません|ございません|見つかりません)[^。]{0,30}/g)].map(m=>m[0]).slice(0,5)});enqueue(page.navigation);}
   if(request.saleEvidence===true){evidence.saleEvidenceRows=[];for(const row of saleRows.slice(0,request.saleEvidenceLimit||1)){if(Date.now()>Date.parse(request.expiresAt))throw Error('診断の有効期限を過ぎました');evidence.currentItem=row.external_id;const detail=await session.detail(row.detail_url,row.external_id),result=saleDetailEvidence(account.site,row,detail);evidence.saleEvidenceRows.push(result);if(result.parseError&&account.site==='auctions'&&session.auctionDetail){try{const auction=await session.auctionDetail(row.external_id);result.alternate=saleDetailEvidence(account.site,row,auction);result.parsed=parseSellerSaleDetail('ヤフオク',detail.text,row.external_id,detail.url,auction);delete result.parseError;}catch(error){result.alternateError=error.message;}}if(result.parseError)break;}evidence.saleEvidence=evidence.saleEvidenceRows[0]||{empty:true};}
   evidence.status='completed';return true;
  }

  if(request.targetSerial){
   if(account.site!=='mercari')throw Error('対象指定の診断はメルカリ1のみです');
   const listing=links.find(link=>/^(出品した商品|出品一覧)$/.test(link.text));if(!listing)throw Error('出品一覧への実リンクを確認できません');
   await session.go(listing.url);evidence.pages.push({kind:'target-list',...await session.structure()});
   const trading=(await session.links()).find(link=>link.text==='取引中');if(trading)await session.go(trading.url);else if(!await session.selectTab('取引中'))throw Error('取引中の一覧を確認できません');
   await session.read('取引中');const target=await session.inspectionTarget(request.targetSerial);evidence.target=target;evidence.pages.push({kind:'target-trades',...await session.structure()});
   const candidates=target.matches.filter(m=>/\/transaction\//.test(m.url));const chosen=candidates.length===1?candidates:target.matches;
   if(chosen.length!==1)throw Error('対象通番号の取引リンクを1件に特定できません');
   await session.go(chosen[0].url);evidence.pages.push({kind:'target-shipping',...await session.structure()});evidence.status='completed';return true;
  }
  if(!links.some(link=>/出品/.test(link.text))){await session.go(account.site==='mercari'?'https://jp.mercari.com/mypage':'https://auctions.yahoo.co.jp/my');links=await session.links();evidence.pages.push({kind:'seller-menu',...await session.structure()});}
  const form=links.find(link=>/^(出品|出品する|出品フォーム)$/.test(link.text));
  const list=links.find(link=>/^(出品した商品|出品一覧|出品中)$/.test(link.text));
  if(list){await session.go(list.url);evidence.pages.push({kind:'seller-list',...await session.structure()});const current=await session.links();links=[...links,...current];}
  if(form){
   await session.go(form.url);const formStructure=await session.structure();evidence.pages.push({kind:'listing-form',...formStructure});let formUrl=form.url;
   const direct=(await session.links()).filter(link=>/^(出品|出品する|出品フォーム)$/.test(link.text)&&link.url!==form.url);
   if(!formStructure.fileInputs?.length&&direct.length===1){formUrl=direct[0].url;await session.go(formUrl);evidence.pages.push({kind:'listing-form-detail',...await session.structure()});}
   if(session.inspectChoice){for(const kind of ['category','condition','shipping']){
    await session.structure();const opened=await session.inspectChoice(kind);(evidence.choiceAttempts??=[]).push({kind,opened});
    if(opened){evidence.pages.push({kind:'choice-'+kind,...await session.structure()});if(kind==='category'&&account.site==='auctions'&&await session.inspectChoice('category-search'))evidence.pages.push({kind:'choice-category-search',...await session.structure()});if(kind==='category'&&session.searchCategory){await session.searchCategory('ブルーレイレコーダー');evidence.pages.push({kind:'choice-category-results',...await session.structure()});if(account.site==='auctions'&&session.categoryFormFromResults){await session.categoryFormFromResults('ブルーレイレコーダー > ソニー',formUrl);evidence.pages.push({kind:'category-specific-form',...await session.structure()});if(session.inspectAuctionOptions){await session.inspectAuctionOptions();evidence.pages.push({kind:'auction-options-form',...await session.structure()});}}}await session.go(formUrl);}
   }}
  }else evidence.listing='出品フォームへの実リンクを取得できません';
  const trading=links.find(link=>/^(取引中|出品終了分)$/.test(link.text));
  if(trading){
   await session.go(trading.url);const page=await session.read(trading.text);if(!page||!Array.isArray(page.rows))throw Error('出品取引一覧の読み込み結果を確認できません');
   evidence.pages.push({kind:'seller-trades',...await session.structure(),rowCount:page.rows.length,itemCount:page.itemCount,statuses:[...new Set(page.rows.map(row=>row.status))]});
   const row=page.rows.find(value=>value.status==='取引中');
   // Inspection can open one actual seller trade link even when the list does not expose its state.
   // This never changes an inventory status, fills a form or presses a shipping button.
   const candidates=row?[{url:row.detail_url}]:await session.inspectionTrades?.()||[];
   evidence.tradeLinkCount=candidates.length;
   if(candidates.length){await session.go(candidates[0].url);evidence.pages.push({kind:'shipping',...await session.structure()});}
   else evidence.shipping=page.empty?'取引中の商品がないため配送画面を確認できません':'発送対象の行を特定できないため配送画面は未確認です';
  }
  evidence.status='completed';
 }catch(error){evidence.status='stopped';evidence.error=error.message;if(request.readShippingQrOnly&&session){try{evidence.pages.push({kind:'shipping-qr-stopped',...await session.structure()});}catch{}}await log('info',account.label+'の読取診断を停止しました。自動再試行しません：'+error.message);}
 finally{await session?.close();await storage.set({sellerInspectionEvidence:evidence});}
 return true;
}