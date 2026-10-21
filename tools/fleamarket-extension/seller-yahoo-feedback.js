/** Seller-only contact preflight. Never opens a guessed buyer/rating URL. */
export function yahooSellerFeedback(args){
 try{
 const {itemId,serial}=args,u=new URL(location.href),n=s=>(s||'').replace(/\s+/g,' ').trim(),v=e=>e.getClientRects().length>0;
 const id=u.searchParams.get('aid')||u.searchParams.get('aID');
 if(u.hostname!=='contact.auctions.yahoo.co.jp'||!['/seller/top','/trade/top'].includes(u.pathname)||id!==itemId)throw Error('出品者の取引ナビを確認できません');
 const root=document.querySelector('main')||document.body,text=n(root.innerText);
 if(document.querySelector('input[type=password],input[autocomplete=one-time-code]')||/追加認証|認証コード|ロボットではない|セキュリティチェック/.test(text))throw Error('ログイン・追加認証が必要です');
 if(!new RegExp('[【\\[]'+serial+'[】\\]]','i').test(text)||/返金申請|キャンセル申請|トラブル申告/.test(text))throw Error('対象通番号または取引状態を確認してください');
 if(!/受け取り連絡がありました|受取連絡済み|受け取り連絡済み|取引が完了しました/.test(text))return {ready:false};
 const links=[...root.querySelectorAll('a[href]')].filter(e=>v(e)&&n(e.innerText)==='落札者を評価する');
 if(links.length!==1)return {ready:false};const link=new URL(links[0].href);
 if(link.protocol!=='https:'||link.username||link.password||link.hostname!=='auctions.yahoo.co.jp'||link.pathname!=='/jp/show/leavefeedback'||(link.searchParams.get('aID')||link.searchParams.get('aid'))!==itemId)throw Error('落札者評価の実リンクが一致しません');
 return {ready:true,ratingUrl:link.href,pageUrl:u.href};
 }catch(e){return {__error:e.message};}
}

/** Seller roles are checked again in the actual posted form, independently of the link. */
export function yahooSellerRating(args){
 try{
 const {itemId,action}=args,u=new URL(location.href),n=s=>(s||'').replace(/\s+/g,' ').trim(),v=e=>e.getClientRects().length>0,text=n(document.body.innerText);
 const ids=new Set([...['aID','aid'].map(k=>u.searchParams.get(k)),...[...document.querySelectorAll('input[type=hidden]')].filter(e=>/^aid$/i.test(e.name)).map(e=>e.value)].filter(Boolean));
 if(u.hostname!=='auctions.yahoo.co.jp'||!['/jp/show/leavefeedback','/jp/preview/leavefeedback'].includes(u.pathname)||ids.size!==1||!ids.has(itemId)||!text.includes('落札者の評価'))throw Error('落札者への評価画面ではありません');
 if(action==='inspect')return {path:u.pathname,heading:text.includes('落札者の評価'),newRating:text.includes('評価の新規入力'),revision:text.includes('評価の変更'),fields:[...document.querySelectorAll('select,textarea,input[type=submit],input[type=hidden]')].filter(e=>v(e)||['isSeller','isBuyer','isRevision','aID'].includes(e.name)).map(e=>({tag:e.tagName,id:e.id||null,name:e.name||null,type:e.type||null,required:e.required===true,value:['isSeller','isBuyer','isRevision','aID'].includes(e.name)?e.value:undefined,label:e.type==='submit'?e.value:undefined,options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,text:n(o.text)})):undefined}))};
 const role=form=>{const get=name=>form.querySelector('input[name="'+name+'"]')?.value||'';if(!['1','true'].includes(get('isSeller'))||/^(1|true)$/.test(get('isBuyer'))||/^(1|true)$/.test(get('isRevision')))throw Error('出品者の新規評価ではありません');return get;};
 if(action==='verify'){
  if(u.pathname!=='/jp/show/leavefeedback'||!text.includes('評価の変更'))throw Error('公開後の評価を確認できません');
  const sections=[...document.querySelectorAll('td,div')].filter(v).map(e=>n(e.innerText)).filter(t=>t.length<400&&t.includes('前回、評価した内容'));
  const section=sections.find(t=>/評価\s+非常に良い\s+評価日時/.test(t)&&(args.comment?t.includes('コメント '+args.comment):/コメント\s*$/.test(t)));
  const d=section?.match(/評価日時\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2})時\s*(\d{1,2})分/);
  const rev=[...document.querySelectorAll('input[name=isRevision]')];
  const stamp=d?Date.parse(`${d[1]}-${d[2].padStart(2,'0')}-${d[3].padStart(2,'0')}T${d[4].padStart(2,'0')}:${d[5].padStart(2,'0')}:00+09:00`):NaN;
  if(!rev.length||rev.some(e=>!['1','true'].includes(e.value))||!Number.isFinite(args.notBefore)||!Number.isFinite(stamp)||stamp<Math.floor(args.notBefore/60000)*60000||stamp>Date.now()+60000)throw Error('今回の評価の反映を確認できません');
  return {success:true,pageUrl:u.href};
 }
 if(action==='prepare'){
  if(u.pathname!=='/jp/show/leavefeedback'||!text.includes('評価の新規入力'))return {alreadyCompleted:true};
  const rating=document.querySelector('select#rating[name=rating]'),comment=document.querySelector('textarea#rate[name=formComment]'),button=document.querySelector('input#decCheck[type=submit]');
  if(!rating||!comment||!button||![rating,comment,button].every(e=>v(e)&&!e.disabled)||comment.value)throw Error('新規評価フォームを確認してください');
  const form=rating.form,post=form&&new URL(form.action);if(!form||comment.form!==form||button.form!==form||form.method!=='post'||post.origin!==u.origin||post.pathname!=='/jp/preview/leavefeedback'||n(button.value)!=='確認する')throw Error('評価確認先が一致しません');role(form);
  const options=[...rating.options].filter(e=>n(e.text)==='非常に良い'&&e.value==='veryGood');if(options.length!==1)throw Error('良い評価を確認できません');
  rating.value='veryGood';rating.dispatchEvent(new Event('change',{bubbles:true}));
  if(comment.required||/コメント\s*[（(]必須[）)]/.test(n(comment.closest('tr')?.innerText))){comment.value='ありがとうございました。';comment.dispatchEvent(new Event('input',{bubbles:true}));}
  if(!form.checkValidity())throw Error('未知の必須項目があります');setTimeout(()=>button.click(),100);return {prepared:true,comment:comment.value};
 }
 if(!['preflight','submit'].includes(action)||u.pathname!=='/jp/preview/leavefeedback'||!text.includes('評価内容の確認'))throw Error('評価確認画面ではありません');
 const buttons=[...document.querySelectorAll('input[type=submit],button[type=submit]')].filter(e=>v(e)&&n(e.value||e.innerText)==='評価を公開する');if(buttons.length!==1||buttons[0].disabled)throw Error('評価公開ボタンを確認できません');
 const form=buttons[0].form,post=form&&new URL(form.action);if(!form||form.method!=='post'||post.origin!==u.origin||post.pathname!=='/jp/submit/leavefeedback')throw Error('評価公開先が一致しません');const get=role(form);let comment=get('previewComment');try{comment=decodeURIComponent(comment);}catch{}
 if(get('aID')!==itemId||get('rating')!=='veryGood'||!['','ありがとうございました。'].includes(args.comment)||comment!==args.comment)throw Error('公開内容が方針と一致しません');
 if(action==='preflight')return {ready:true};setTimeout(()=>buttons[0].click(),100);return {submitRequested:true};
 }catch(e){return {__error:e.message};}
}
