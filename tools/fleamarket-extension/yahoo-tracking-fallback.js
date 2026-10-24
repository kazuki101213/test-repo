// Read-only buyer transaction tabs; never submit a form or send a message.
export function yahooTrackingPage({expectedItemId,phase='inspect'}){
 try{
 const norm=t=>(t||'').normalize('NFKC').replace(/\s+/g,' ').trim();
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const idOf=value=>{try{const u=new URL(value,location.href);if(u.protocol!=='https:'||!['contact.auctions.yahoo.co.jp','auctions.yahoo.co.jp','page.auctions.yahoo.co.jp'].includes(u.hostname))return null;return u.pathname.match(/\/auction\/((?:[a-zA-Z]\d+|\d{10}))/)?.[1]||['aid','aID','auctionID'].map(k=>u.searchParams.get(k)).find(v=>/^(?:[a-zA-Z]\d+|\d{10})$/.test(v||''));}catch{return null;}};
 const u=new URL(location.href);if(u.origin!=='https://contact.auctions.yahoo.co.jp'||!/^\/trade\/(?:top|bundle|message|messages)\/?$/.test(u.pathname)||idOf(u.href)!==expectedItemId)throw Error('追跡確認の取引URL・商品IDが一致しません');
 const scopes=[...document.querySelectorAll('main')].filter(visible);if(scopes.length!==1)throw Error('追跡確認の表示領域を1件に確定できません');const root=scopes[0],text=norm(root.innerText);
 if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/認証コードを入力|ロボットではない|セキュリティチェック/.test(text))throw Error('追加認証が必要です');
 const links=[...root.querySelectorAll('a[href]')].filter(visible);
 const productLinks=links.filter(e=>/\/auction\/(?:[a-zA-Z]\d+|\d{10})/.test(new URL(e.href).pathname));
 const headerLinks=productLinks.filter(e=>e.closest('h1,h2,h3')||norm(e.innerText)==='商品ページ');
 const isBundle=u.pathname==='/trade/bundle';
 if(!isBundle&&headerLinks.some(e=>idOf(e.href)!==expectedItemId))throw Error('取引見出しに別商品のIDが含まれています');
 const declaredIds=[...new Set([...text.matchAll(/オークションID\s*[:：]\s*((?:[a-zA-Z]\d+|\d{10}))/g)].map(m=>m[1]))];
 if(!isBundle&&declaredIds.some(id=>id!==expectedItemId))throw Error('取引の表示商品IDが一致しません');
 const declaredMatch=declaredIds.length===1&&declaredIds[0]===expectedItemId;
 if(!isBundle&&!headerLinks.some(e=>idOf(e.href)===expectedItemId)&&!declaredMatch)throw Error('取引見出しの商品IDを確認できません');
 const ids=[...new Set(productLinks.map(e=>idOf(e.href)).filter(Boolean))];
 if(isBundle&&(!/まとめて取引/.test(text)||!ids.includes(expectedItemId)))throw Error('同梱対象の商品一覧を確認できません');
 const exactLinks=label=>links.filter(e=>norm(e.innerText)===label);
 const safeTrade=(link,path,id)=>{if(!link)return null;const x=new URL(link.href);return x.origin===u.origin&&x.pathname===path&&idOf(x.href)===id?x.href:null;};
 const parentLinks=exactLinks('まとめて取引を確認する');const parent=parentLinks.length===1?parentLinks[0]:null;
 const parentId=parent&&idOf(parent.href);const parentUrl=parentId&&parentId!==expectedItemId&&/まとめて取引/.test(text)?safeTrade(parent,'/trade/top',parentId):null;
 const bundleLinks=exactLinks('まとめて取引する商品を見る');const bundleUrl=bundleLinks.length===1?safeTrade(bundleLinks[0],'/trade/bundle',expectedItemId):null;
 const controls=[...root.querySelectorAll('a,button,[role=tab]')].filter(e=>visible(e)&&/^(メッセージ|取引メッセージ)$/.test(norm(e.innerText)));
 if(phase==='open-messages'){
  if(controls.length!==1)return {available:false};const control=controls[0];
  if(control.matches('a[href]')){const href=control.href,x=new URL(href);if(x.origin!==u.origin||idOf(href)!==expectedItemId||!/^\/trade\/(?:top|message|messages)\/?$/.test(x.pathname))throw Error('メッセージのリンクが同じ取引ではありません');if(href!==u.href)return {available:true,url:href};}
  if(control.matches('input,[type=submit]')||control.disabled||control.closest('form'))throw Error('メッセージ閲覧以外の操作はしません');
  setTimeout(()=>control.click(),0);return {available:true,changing:true,beforeUrl:u.href};
 }
 const numbers=new Set();for(const match of text.matchAll(/(?:追跡番号|お問い合わせ(?:伝票)?番号|お問合せ番号|問い合わせ番号|問合せ番号|送り状番号|伝票番号)[：:\s]*([0-9][0-9\s\-－]{6,26}[0-9])/g)){const number=match[1].replace(/[\s\-－]/g,'');if(/^\d{8,20}$/.test(number))numbers.add(number);}
 return {url:u.href,itemId:expectedItemId,identitySource:declaredMatch?'auction-id-label':isBundle?'bundle-list':'product-heading',trackingNo:numbers.size===1?[...numbers][0]:null,trackingAmbiguous:numbers.size>1,parentId:parentUrl?parentId:null,parentUrl,bundleUrl,bundleIds:isBundle?ids:[],messageAvailable:controls.length===1,messageNumberCandidates:[...text.matchAll(/(?<![a-zA-Z0-9])[0-9][0-9 -]{7,24}[0-9](?![a-zA-Z0-9])/g)].map(m=>m[0].replace(/[^0-9]/g,'')).filter(n=>/^\d{8,20}$/.test(n)).slice(0,12)};
 }catch(error){return {__error:error.message};}
}

export async function yahooTrackingFallback({itemId,navigate,inspect,openMessages,settle}){
 let currentId=itemId,proof=[],page=await inspect(currentId);
 if(page.trackingNo||page.trackingAmbiguous)return {...page,itemId,role:'buyer',trackingSource:'transaction'};
 if(page.parentUrl){
  if(!page.bundleUrl)throw Error('同梱商品一覧のリンクを確認できません');
  const parentUrl=page.parentUrl,parentId=page.parentId;await navigate(page.bundleUrl);const bundle=await inspect(currentId);
  if(!bundle.bundleIds?.includes(itemId)||!bundle.bundleIds.includes(parentId))throw Error('同じ配送便の商品IDを一覧で確認できません');
  proof=bundle.bundleIds;await navigate(parentUrl);currentId=parentId;page=await inspect(currentId);
 }
 if(page.trackingNo||page.trackingAmbiguous)return {...page,itemId,role:'buyer',bundleIds:proof,trackingSource:'bundle-transaction'};
 if(!page.messageAvailable)return {...page,itemId,role:'buyer',bundleIds:proof,trackingSource:'unavailable'};
 const opened=await openMessages(currentId);if(!opened.available)return {...page,itemId,role:'buyer',bundleIds:proof,trackingSource:'unavailable'};
 if(opened.url)await navigate(opened.url);else if(opened.changing)await settle(currentId,opened.beforeUrl);
 page=await inspect(currentId);return {...page,itemId,role:'buyer',bundleIds:proof,trackingSource:proof.length?'bundle-message':'message'};
}
