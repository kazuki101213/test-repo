// Executed only in the account's existing, identity-checked buyer transaction tab.
export async function yahooReceiptPage(args){
 try{
 const {itemId,action='inspect'}=args;
 const norm=s=>(s||'').replace(/\s+/g,' ').trim();
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const u=new URL(location.href);
 const actualId=['aID','aid','auctionID','auctionId'].map(k=>u.searchParams.get(k)).find(v=>/^[a-zA-Z]\d+$/.test(v||''));
 if(u.hostname!=='contact.auctions.yahoo.co.jp'||!['/trade/top','/buyer/top'].includes(u.pathname)||actualId!==itemId)throw Error('受取連絡の商品ID・取引画面が一致しません');
 const roots=[...document.querySelectorAll('main')].filter(visible);if(roots.length!==1)throw Error('取引領域を一意に確認できません');const root=roots[0];
 if(document.querySelector('input[type="password"]'))throw Error('ログイン切れ');
 const text=norm(root.innerText);
 if([...root.querySelectorAll('a,button,input[type="submit"]')].some(e=>visible(e)&&/^(発送通知をする|購入者を評価する)$/.test(norm(e.innerText||e.value))))throw Error('出品者側の操作があるため停止しました');
 const received=()=>{
  // Help text may mention receipt completion before the actual operation.
  if([...root.querySelectorAll('a')].some(e=>visible(e)&&norm(e.innerText)==='受け取り連絡をする'))return false;
  return [...root.querySelectorAll('p,[role="status"],[role="alert"]')].some(e=>visible(e)&&/^(取引が完了しました|受け取り連絡(?:が|は)?完了しました|受け取り連絡を(?:行いました|しました))/.test(norm(e.innerText)));
 };
 const inspect=()=>({received:received(),controls:[...root.querySelectorAll('button,a,input:not([type="hidden"]),select,textarea,label')].filter(visible).flatMap(e=>{
  const label=norm(e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder'));
  if(!/評価|受取|受け取|良い|良かった|よい|確認|送信|投稿|次へ/.test(label)&&!e.matches('input[type="radio"],input[type="checkbox"],textarea,select'))return [];
  return [{tag:e.tagName,type:e.type||null,label:label.slice(0,140),name:e.name||null,id:e.id||null,class:typeof e.className==='string'?e.className:null,required:e.required===true,disabled:e.disabled===true,options:e.tagName==='SELECT'?[...e.options].map(o=>({label:o.text,value:o.value})):undefined,href:e.tagName==='A'?(()=>{try{const x=new URL(e.href);return {host:x.hostname,path:x.pathname,keys:[...x.searchParams.keys()]}}catch{return null}})():undefined}];
 }).slice(0,35),statusTexts:[...root.querySelectorAll('h1,h2,h3,p')].filter(visible).map(e=>norm(e.innerText)).filter(t=>t.length<250&&/受け取り連絡|評価/.test(t)).slice(0,15)});
 if(action==='ratingLink'){
  if(!received())throw Error('受取連絡の完了前には出品者評価へ進めません');
  const links=[...root.querySelectorAll('a[href]')].filter(e=>visible(e)&&norm(e.innerText)==='出品者を評価する');
  if(links.length!==1)throw Error('出品者評価リンクを一意に確認できません');
  const target=new URL(links[0].href);
  if(target.hostname!=='auctions.yahoo.co.jp'||target.pathname!=='/jp/show/leavefeedback'||target.searchParams.get('aID')!==itemId)throw Error('出品者評価リンクの商品IDが一致しません');
  return {url:target.href};
 }
 if(action==='inspect')return inspect();
 if(!['preflight','receive'].includes(action))throw Error('受取連絡の操作が不正です');
 if(received())return {...inspect(),clicked:false};
 const checks=[...root.querySelectorAll('input[type="checkbox"]')].filter(e=>visible(e)&&norm(e.labels?.[0]?.innerText)==='商品を受け取りました');
 const buttons=[...root.querySelectorAll('a')].filter(e=>visible(e)&&norm(e.innerText)==='受け取り連絡をする');
 if(checks.length!==1||buttons.length!==1||checks[0].disabled)throw Error('検証済み受取連絡欄が一致しません');
 const checkbox=checks[0],button=buttons[0];
 if(!checkbox.parentElement?.parentElement?.parentElement?.contains(button)||!button.className.includes('gv-Button--'))throw Error('受取連絡欄の構造が変わりました');
 if(action==='preflight')return {ready:true,...inspect()};
 if(!checkbox.checked)checkbox.click();
 await new Promise(r=>setTimeout(r,400));
 if(!checkbox.checked||button.className.includes('gv-Button--disabled--')||button.getAttribute('aria-disabled')==='true'||!visible(button))throw Error('受取連絡ボタンが有効になりません');
 if(location.href!==u.href||!root.contains(button))throw Error('送信前に取引画面が変わりました');
 button.click();
 for(let n=0;n<20;n++){await new Promise(r=>setTimeout(r,400));if(received()||document.querySelector('[role="dialog"]'))break;}
 return {...inspect(),clicked:true};
 }catch(error){if(args.reportErrors)return {error:error.message};throw error;}
}
