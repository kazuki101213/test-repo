const PROFILE_ACCOUNTS={
 'ba92b386-e0bc-48be-b3b6-ca9550fa1a2d':'auctions-1',
 'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':'mercari-1',
};
export function sellerInspectionApplies(request,profileId,previous,now=Date.now()){
 if(!request||!PROFILE_ACCOUNTS[profileId]||request.id===previous||!/^[-0-9a-f]{36}$/i.test(request.id||''))return false;
 const issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt);
 return request.kind==='seller-readonly-structure'&&Array.isArray(request.profiles)&&request.profiles.includes(profileId)&&request.profiles.every(id=>!!PROFILE_ACCOUNTS[id])&&Number.isFinite(issued)&&Number.isFinite(expires)&&issued<=now&&expires>now&&expires-issued<=15*60000;
}
/** Fixed diagnostic: returns control structure, never field values, cookies or page HTML. */
export async function readSellerStructure(){
 const norm=value=>(value||'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const u=new URL(location.href);let root=document.querySelector('main')||document.body;
 const end=Date.now()+10000;while(Date.now()<end){root=document.querySelector('main')||document.body;const t=norm(root.innerText);const ready=u.hostname==='jp.mercari.com'&&u.pathname==='/mypage/listings'?/出品した商品|出品中|取引中|売却済み/.test(t):u.pathname.includes('/sell/create')?!!root.querySelector('input[type="file"],input[name="name"],textarea'):!!t;
  if(ready&&!root.querySelector('[aria-busy="true"]'))break;await new Promise(resolve=>setTimeout(resolve,250));}
 const body=norm(root.innerText);
 if(document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')||/文字認証|認証コードを入力|ロボットではない|セキュリティチェック|ログインしてください/.test(body))throw Error('ログイン・追加認証のため診断を停止しました');
 const label=e=>norm([e.getAttribute('aria-label'),...(e.labels?[...e.labels].map(l=>l.innerText):[]),...(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.innerText),e.getAttribute('placeholder')].filter(Boolean).join(' ')).slice(0,120);
 const recognized=/出品|取引|配送|発送|商品|写真|画像|カテゴリー|カテゴリ|価格|説明|状態|送料|サイズ|自動|終了|メッセージ|コード/;
 const selectionPage=/カテゴリ|カテゴリー|商品の状態|配送の方法/.test(norm(root.querySelector('h1,h2,[role="dialog"]')?.innerText));
 const section=e=>{for(let p=e.parentElement,n=0;p&&n<4;p=p.parentElement,n++){const h=[...p.children].find(c=>/^(H2|H3|H4|LEGEND|DT)$/.test(c.tagName));if(h)return norm(h.innerText).slice(0,100);}return null;};
 const controls=[...root.querySelectorAll('input:not([type="hidden"]),textarea,select,button,a,[role="button"],[role="combobox"],[role="tab"],[contenteditable="true"]')].filter(visible).map(e=>{
  const text=e.matches('button,a,[role="button"],[role="tab"],input[type="button"],input[type="submit"]')?norm(e.innerText||e.getAttribute('aria-label')||e.value).slice(0,100):label(e);
  if(!e.matches('input,textarea,select')&&!text)return null;if(e.tagName==='A'&&!selectionPage&&!/選択|変更|設定|選んで|未設定|出品|取引|配送|発送/.test(text))return null;
  return {tag:e.tagName,type:e.type||null,role:e.getAttribute('role'),name:e.name||null,id:e.id||null,testId:e.getAttribute('data-testid'),section:section(e),label:text,optionValue:e.type==='radio'||e.type==='checkbox'?e.getAttribute('value'):undefined,disabled:e.disabled===true,required:e.required===true,accept:e.type==='file'?e.accept:null,options:e.tagName==='SELECT'?[...e.options].slice(0,60).map(o=>norm(o.text).slice(0,60)):undefined};
 }).filter(Boolean).slice(0,100);
 const links=[...root.querySelectorAll('a[href]')].filter(visible).flatMap(e=>{const text=norm(e.innerText);if(!/^(出品|出品する|出品した商品|出品一覧|出品中|取引中|売却済み|出品終了分|売上金管理|取引ナビ|発送する|配送方法を選択する)$/.test(text))return [];try{const x=new URL(e.href);return [{text,host:x.hostname,path:x.pathname,queryKeys:[...x.searchParams.keys()]}];}catch{return [];}}).slice(0,30);
 const notices=[...root.querySelectorAll('p,[role="status"],h2,h3,span')].filter(e=>visible(e)&&!e.children.length).map(e=>norm(e.innerText)).filter(t=>t.length<100&&/商品.*(?:ありません|ない|ございません)|取引.*(?:ありません|ない|ございません)|読み込み中|エラー|発送して|発送待ち|支払い待ち|チャージ完了/.test(t)).slice(0,12);
 return {host:u.hostname,path:u.pathname.replace(/\b(?:m[0-9]{7,}|[a-z][0-9]{8,})\b/gi,'[item]'),queryKeys:[...u.searchParams.keys()],notices,controls,links,headings:[...root.querySelectorAll('h1,h2,h3')].filter(visible).map(e=>norm(e.innerText)).filter(t=>recognized.test(t)&&t.length<80).slice(0,12),fileInputs:[...root.querySelectorAll('input[type="file"]')].map(e=>({accept:e.accept,multiple:e.multiple,disabled:e.disabled,id:e.id||null,name:e.name||null,visible:visible(e),section:section(e)})),backingFields:[...root.querySelectorAll('select,textarea')].filter(e=>!visible(e)).map(e=>({tag:e.tagName,id:e.id||null,name:e.name||null,section:section(e)})).slice(0,30),editorFrames:[...root.querySelectorAll('iframe')].map(e=>({id:e.id||null,title:e.title||null})),shippingCodesVisible:!!root.querySelector('canvas[aria-label*="QR"],img[alt*="QR"],img[alt*="2次元"]')};
}
/** Borrow registered seller tabs once; no data entry, submission, RPC writes or new tabs. */
export async function runSellerReadOnlyInspection({settings,profileId,storage,fetchRequest,openSession,log}){
 const request=await fetchRequest(),previous=(await storage.get('sellerInspectionRequest')).sellerInspectionRequest;
 if(!sellerInspectionApplies(request,profileId,previous))return false;
 const account=settings.accounts.find(a=>a.enabled&&a.id===PROFILE_ACCOUNTS[profileId]);if(!account)return false;
 await storage.set({sellerInspectionRequest:request.id});
 const evidence={requestId:request.id,accountId:account.id,at:new Date().toISOString(),pages:[],readOnly:true};let session;
 try{
  session=await openSession(account);evidence.pages.push({kind:'identity',...await session.structure()});
  let links=await session.links();
  if(!links.some(link=>/出品/.test(link.text))){await session.go(account.site==='mercari'?'https://jp.mercari.com/mypage':'https://auctions.yahoo.co.jp/my');links=await session.links();evidence.pages.push({kind:'seller-menu',...await session.structure()});}
  const form=links.find(link=>/^(出品|出品する|出品フォーム)$/.test(link.text));
  const list=links.find(link=>/^(出品した商品|出品一覧|出品中)$/.test(link.text));
  if(list){await session.go(list.url);evidence.pages.push({kind:'seller-list',...await session.structure()});const current=await session.links();links=[...links,...current];}
  if(form){
   await session.go(form.url);evidence.pages.push({kind:'listing-form',...await session.structure()});let formUrl=form.url;
   const direct=(await session.links()).filter(link=>/^(出品|出品する|出品フォーム)$/.test(link.text)&&link.url!==form.url);
   if(direct.length===1){formUrl=direct[0].url;await session.go(formUrl);evidence.pages.push({kind:'listing-form-detail',...await session.structure()});}
   if(session.inspectChoice){for(const kind of ['category','condition','shipping']){
    await session.structure();const opened=await session.inspectChoice(kind);(evidence.choiceAttempts??=[]).push({kind,opened});
    if(opened){evidence.pages.push({kind:'choice-'+kind,...await session.structure()});await session.go(formUrl);}
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
 }catch(error){evidence.status='stopped';evidence.error=error.message;await log('info',account.label+'の読取診断を停止しました。自動再試行しません：'+error.message);}
 finally{await session?.close();await storage.set({sellerInspectionEvidence:evidence});}
 return true;
}
