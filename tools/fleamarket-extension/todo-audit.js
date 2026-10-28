/** Read-only buyer receipt/evaluation evidence. No input changes or clicks. */
export async function readBuyerTodoState({itemId,stage}){
 try{
  const u=new URL(location.href),n=s=>(s||'').replace(/\s+/g,' ').trim(),v=e=>e.getClientRects().length>0;
  if(!/^[a-z][0-9]{8,14}$/.test(itemId)||!['receipt','rating'].includes(stage))throw Error('確認対象が不正です');
  const id=u.searchParams.get('aID')||u.searchParams.get('aid');
  if(id!==itemId||!(stage==='receipt'?u.hostname==='contact.auctions.yahoo.co.jp'&&['/trade/top','/buyer/top'].includes(u.pathname):u.hostname==='auctions.yahoo.co.jp'&&u.pathname==='/jp/show/leavefeedback'))throw Error('商品ID・確認画面が一致しません');
  const end=Date.now()+15000;
  while(Date.now()<end&&!/受け取り連絡|受取連絡|評価の変更|評価の新規入力/.test(document.body.innerText))await new Promise(r=>setTimeout(r,250));
  const text=n(document.body.innerText);
  if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/ログインしてください|認証コードを入力|ロボットではない|セキュリティチェック/.test(text))throw Error('ログイン・追加認証が必要です');
  if(stage==='rating'){
   const hidden=name=>[...document.querySelectorAll('input[type=hidden]')].filter(e=>e.name===name).map(e=>e.value);
   if(!hidden('aID').includes(itemId)&&!hidden('aid').includes(itemId))throw Error('評価フォームの商品IDを確認できません');
   const buyer=hidden('isBuyer').some(x=>['true','1'].includes(x)),seller=hidden('isSeller').some(x=>['true','1'].includes(x));
   if(!buyer||seller)throw Error('購入者としての評価画面を確認できません');
   return {itemId,stage,buyer:true,seller:false,evaluated:text.includes('評価の変更')&&text.includes('前回、評価した内容')&&hidden('isRevision').some(x=>['true','1'].includes(x)),newEvaluation:text.includes('評価の新規入力')&&hidden('isRevision').some(x=>['false','0'].includes(x)),observedAt:new Date().toISOString()};
  }
  const roots=[...document.querySelectorAll('main')].filter(v);if(roots.length!==1)throw Error('取引領域を確認できません');const root=roots[0];
  const links=[...root.querySelectorAll('a[href]')].filter(v),labels=links.map(a=>n(a.innerText));
  if(labels.some(t=>/^(発送通知をする|購入者を評価する)$/.test(t)))throw Error('出品者側の取引画面です');
  const controls=[...root.querySelectorAll('a,button,input[type=submit]')].filter(v).map(e=>n(e.innerText||e.value));
  const pending=controls.some(t=>/^(受け取り|受取)連絡をする$/.test(t));
  const received=!pending&&[...root.querySelectorAll('p,[role=status],[role=alert]')].filter(v).some(e=>/^(取引が完了しました|受け取り連絡(?:が|は)?完了しました|受け取り連絡を(?:行いました|しました))/.test(n(e.innerText)));
  const candidates=links.filter(a=>n(a.innerText)==='出品者を評価する').map(a=>new URL(a.href)).filter(x=>x.protocol==='https:'&&x.hostname==='auctions.yahoo.co.jp'&&x.pathname==='/jp/show/leavefeedback'&&x.searchParams.get('aID')===itemId&&!x.username&&!x.password);
  const statusTexts=[...root.querySelectorAll('p,h1,h2,h3,[role=status],[role=alert],button,a')].filter(v).map(e=>n(e.innerText)).filter(t=>t.length<200&&/受取|受け取|評価|取引|オークション.*表示|ログイン/.test(t)).slice(0,25);
  return {itemId,stage,received,pending,statusTexts,ratingUrl:received&&candidates.length===1?candidates[0].href:null,observedAt:new Date().toISOString()};
 }catch(error){return {__error:error.message};}
}
