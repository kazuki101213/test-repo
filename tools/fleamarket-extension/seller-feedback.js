/** No requests: classify a row already read by the existing seller scan. */
export function sellerFeedbackPending(site,text){
 const s=String(text||'').replace(/\s+/g,' ');
 if(/キャンセル|中止|返品|返金|トラブル|支払い待ち|発送してください|購入者の受取評価待ち|購入者からの(?:受取)?評価待ち|受取評価をお待ち/.test(s))return false;
 return site==='mercari'?/評価してください|購入者を評価|評価待ち/.test(s):site==='auctions'&&/落札者を評価|評価してください|評価待ち/.test(s)&&/受取連絡|受け取り連絡|受取完了|取引完了/.test(s);
}

/** Injected in an identity-verified seller tab. Never reads or sends transaction messages. */
export async function mercariSellerFeedback(args){
 try{
 const {itemId,serial,action='inspect'}=args,n=s=>(s||'').replace(/\s+/g,' ').trim(),visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 if(location.hostname!=='jp.mercari.com'||location.pathname!=='/transaction/'+itemId||!/^m[0-9]+$/.test(itemId)||!/^\d+[a-z]*$/.test(serial))throw Error('出品取引の商品IDが一致しません');
 const mains=[...document.querySelectorAll('main')].filter(visible);if(mains.length!==1)throw Error('取引画面を一意に確認できません');const root=mains[0],text=n(root.innerText);
 if(action==='structure')return {pageUrl:location.href,phrases:[...document.querySelectorAll('p,h1,h2,h3,[role=alert]')].filter(visible).map(e=>n(e.innerText)).filter(t=>t.length<180&&/評価|取引.*完了|キャンセル|エラー/.test(t)).slice(0,20),dialogs:[...document.querySelectorAll('[role=dialog],dialog')].filter(visible).map(e=>({heading:[...e.querySelectorAll('h1,h2,h3')].map(h=>n(h.innerText)),text:n(e.innerText).slice(0,500),buttons:[...e.querySelectorAll('button')].filter(visible).map(b=>({label:n(b.innerText),disabled:b.disabled}))})),buttons:[...root.querySelectorAll('button')].filter(visible).map(e=>n(e.innerText)).filter(t=>/評価|完了|送信|キャンセル/.test(t))};
 if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/追加認証|認証コード|ロボットではない|セキュリティチェック/.test(text))throw Error('ログイン・追加認証が必要です');
 if(!new RegExp('[【\\[]'+serial+'[】\\]]','i').test(text)||!text.includes(itemId)||!/購入者情報/.test(text))throw Error('出品者・通番号・商品IDを確認できません');
 const buttons=()=>[...root.querySelectorAll('button')].filter(e=>visible(e)&&n(e.innerText)==='購入者を評価して取引完了する');
 const completed=()=>/取引が完了しました|この取引は完了しています/.test(n(root.innerText))&&buttons().length===0;
 if(action==='result'){
  const end=Date.now()+15000;do{if(completed())return {success:true,pageUrl:location.href,positive:'良かった'};if(Date.now()<end)await new Promise(r=>setTimeout(r,250));}while(Date.now()<end);
  throw Error('購入者評価の完了表示を確認できません。再送しません');
 }
 if(completed())return {alreadyCompleted:true,ready:false};
 if(buttons().length===0&&/購入者の受取評価待ち|購入者からの(?:受取)?評価待ち|受取評価をお待ち/.test(text))return {ready:false,waitingForBuyer:true};
 if(/商品が届いたら|受け取り評価をする|受取評価をする|発送してください|支払いをお待ち|返品申請|キャンセル申請/.test(text))throw Error('出品者の評価待ち画面ではありません');
 const candidates=buttons();if(candidates.length!==1||candidates[0].disabled)throw Error('購入者への評価ボタンを一意に確認できません');
 const good=[...root.querySelectorAll('input[type=radio][name=fame][value=good]')].filter(visible),bad=[...root.querySelectorAll('input[type=radio][name=fame][value=bad]')].filter(visible);
 const comments=[...root.querySelectorAll('textarea[name=message]')].filter(visible);
 if(good.length!==1||bad.length!==1||comments.length!==1||good[0].disabled||comments[0].disabled||!['submit','confirm'].includes(action)&&comments[0].value)throw Error('評価フォームまたは入力済みコメントを確認してください');
 if(![...good[0].labels].some(e=>n(e.innerText)==='良かった')||!text.includes('取引評価'))throw Error('良い評価の選択肢が一致しません');
 if(bad[0].checked)throw Error('残念だったが選択されているため自動変更しません');
 if(action==='inspect')return {ready:true,commentRequired:comments[0].required===true,positive:'良かった',pageUrl:location.href};
 if(!['prepare','submit','confirm'].includes(action))throw Error('未対応の評価操作です');
 if(action==='prepare'){
  if(!good[0].checked)good[0].click();
  if(comments[0].required){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(comments[0],'ありがとうございました。');comments[0].dispatchEvent(new Event('input',{bubbles:true}));comments[0].dispatchEvent(new Event('change',{bubbles:true}));}
  return {prepared:good[0].checked,comment:comments[0].value};
 }
 if(!good[0].checked||bad[0].checked||comments[0].value!==(comments[0].required?'ありがとうございました。':''))throw Error('評価内容が方針と一致しません');
 if(action==='confirm'){
  const dialogs=[...document.querySelectorAll('[role=dialog],dialog')].filter(e=>visible(e)&&n(e.innerText).includes('購入者を評価して取引を完了しますか？'));
  if(dialogs.length!==1)throw Error('購入者評価の確認ダイアログを一意に確認できません');
  const controls=[...dialogs[0].querySelectorAll('button')].filter(visible),final=controls.filter(e=>n(e.innerText)==='取引を完了する');
  if(final.length!==1||final[0].disabled||!controls.some(e=>n(e.innerText)==='キャンセル')||controls.some(e=>!['取引を完了する','キャンセル',''].includes(n(e.innerText))))throw Error('購入者評価の最終確認が一致しません');
  setTimeout(()=>final[0].click(),100);return {confirmationRequested:true};
 }
 const form=candidates[0].form;if(form&&!form.checkValidity())throw Error('未知の必須項目があるため停止しました');
 setTimeout(()=>candidates[0].click(),100);return {submitRequested:true};
 }catch(e){return {__error:e.message};}
}

/** Durable reservation precedes any submission; interrupted work is never retried. */
export async function processSellerFeedback({account,rows,session,rpc,storage,log,now=Date.now()}){
 const pending=rows.filter(r=>r.feedback_pending===true&&!r.attention&&['取引中','販売済'].includes(r.status));
 if(!pending.length)return {rated:0,errors:0};
 const key='sellerFeedbackChecks',saved=(await storage.get(key))[key]||{},checks={...saved},day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(new Date(now));
 const eligible=pending.filter(r=>!checks[account.id+':'+r.external_id]||checks[account.id+':'+r.external_id].day!==day&&!['succeeded','unknown','skipped'].includes(checks[account.id+':'+r.external_id].state)).slice(0,40);
 if(!eligible.length)return {rated:0,errors:0};
 const plans=await rpc('seller_feedback_candidates',{p_account_id:account.id,p_ids:eligible.map(r=>r.external_id)});
 if(!Array.isArray(plans))throw Error('購入者評価の在庫照合結果が不正です');
 let rated=0,errors=0;
 for(const row of eligible){
  const id=account.id+':'+row.external_id,plan=plans.find(p=>p.external_id===row.external_id);let token=null,begun=false;
  checks[id]={day,state:plan?.state||'checked'};await storage.set({[key]:checks});
  if(!plan||plan.state)continue;
  const call=(action,note='')=>rpc('seller_feedback_record',{p_account_id:account.id,p_external_id:row.external_id,p_trade_key:plan.trade_key,p_action:action,p_token:token,p_note:note});
  try{
   const go=session.feedbackGo||session.go;
   if(account.site==='mercari')await go('https://jp.mercari.com/transaction/'+row.external_id);
   else{
    let target=row.feedback_url||row.detail_url,u=new URL(target);
    if(u.hostname!=='contact.auctions.yahoo.co.jp'||!['/seller/top','/trade/top'].includes(u.pathname)){
     const source=await session.auctionDetail(row.external_id),sourceUrl=new URL(source.url);
     if(sourceUrl.hostname==='contact.auctions.yahoo.co.jp')target=source.url;
     else{const links=source.links.filter(l=>{try{const x=new URL(l.url);return x.protocol==='https:'&&!x.username&&!x.password&&x.hostname==='contact.auctions.yahoo.co.jp'&&['/seller/top','/trade/top'].includes(x.pathname)&&(x.searchParams.get('aid')||x.searchParams.get('aID'))===row.external_id&&/取引ナビ/.test(l.text);}catch{return false;}});if(links.length!==1)throw Error('出品者の取引ナビへの実リンクを確認できません');target=links[0].url;}
    }
    await go(target);
   }
   const args={itemId:row.external_id,serial:plan.sku.split('-')[0].toLowerCase()};
   const ready=await session.feedback({...args,action:'inspect'});if(ready.alreadyCompleted){checks[id].state='skipped';continue;}if(!ready.ready)continue;
   const reservation=await call('reserve');if(!reservation?.claimed)continue;token=reservation.token;
   if(account.site==='mercari'){
    const prepared=await session.feedback({...args,action:'prepare'});if(!prepared.prepared)throw Error('評価内容を準備できません');
    await call('begin');begun=true;checks[id].state='unknown';await storage.set({[key]:checks});
    const sent=await session.feedback({...args,action:'submit'});if(!sent.submitRequested)throw Error('評価送信を確認できません');
    await session.loaded();await session.feedback({...args,action:'confirm'});await session.loaded();const result=await session.feedback({...args,action:'result'});if(!result.success)throw Error('評価完了を確認できません');
   }else await session.feedbackWorkflow({...args,beforePublish:async()=>{await call('begin');begun=true;checks[id].state='unknown';await storage.set({[key]:checks});}});
   await call('complete','良い評価の完了表示を実画面で確認');checks[id].state='succeeded';rated++;await log('info','購入者への良い評価が完了しました',{account:account.label,itemId:row.external_id});
  }catch(e){errors++;checks[id].state=begun?'unknown':'checked';if(token){try{await call(begun?'unknown':'skip','自動再送停止：'+e.message.slice(0,200));checks[id].state=begun?'unknown':'skipped';}catch{checks[id].state='unknown';}}
   if(begun&&account.site==='mercari'){try{await storage.set({sellerFeedbackIssue:{itemId:row.external_id,accountId:account.id,structure:await session.feedback({itemId:row.external_id,serial:plan.sku.split('-')[0].toLowerCase(),action:'structure'})}});session.preserveForReview?.();}catch{}}
   await log('error',account.label+'の購入者評価を停止しました。自動再送しません：'+e.message,{itemId:row.external_id});
   // Account/session failures must stop this account, rather than open more transactions.
   break;
  }finally{await storage.set({[key]:Object.fromEntries(Object.entries(checks).slice(-2000))});}
 }
 return {rated,errors};
}
