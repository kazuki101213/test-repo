export function yahooRatingPage(args){
 try{
  const {itemId,action='inspect'}=args,n=s=>(s||'').replace(/\s+/g,' ').trim(),u=new URL(location.href);
  if(action==='submissionResult'){
   const heading=[...document.querySelectorAll('td,th,p,font,b,h1,h2,h3')].some(e=>e.getClientRects().length>0&&n(e.innerText)==='出品者の評価');
   if(u.hostname!=='auctions.yahoo.co.jp'||u.pathname!=='/jp/submit/leavefeedback'||!heading||[...document.querySelectorAll('input[type="submit"]')].some(e=>e.getClientRects().length>0&&n(e.value)==='評価を公開する'))throw Error('評価公開後の応答画面を確認できません');
   return {submissionResult:true,pageUrl:u.href};
  }
  const ids=new Set([...['aID','aid','auctionID','auctionId'].map(k=>u.searchParams.get(k)),...[...document.querySelectorAll('input[type="hidden"]')].filter(e=>/^(aid|auctionid)$/i.test(e.name)).map(e=>e.value)].filter(Boolean));
  if(u.hostname!=='auctions.yahoo.co.jp'||!['/jp/show/leavefeedback','/jp/preview/leavefeedback'].includes(u.pathname)||ids.size!==1||!ids.has(itemId))throw Error('出品者評価の商品ID・画面が一致しません');
  const visible=e=>e.getClientRects().length>0;
  const inspect=()=>({host:u.hostname,path:u.pathname,fields:[...document.querySelectorAll('input:not([type="hidden"]),select,textarea,button')].filter(visible).map(e=>({tag:e.tagName,type:e.type||null,id:e.id||null,name:e.name||null,label:n(e.labels?.[0]?.innerText||e.innerText||e.value).slice(0,150),required:e.required===true,options:e.tagName==='SELECT'?[...e.options].map(o=>({text:n(o.text),value:o.value})):undefined})),markers:[...document.querySelectorAll('td,th,p,h1,h2,h3')].filter(visible).map(e=>n(e.innerText)).filter(t=>t.length<170&&/評価の新規入力|評価の変更|非常に良い|コメント.*(?:入力|必須)|評価を公開|評価.*(?:完了|受け付け)/.test(t)).slice(0,20),forms:[...document.forms].map(f=>({method:f.method,path:new URL(f.action).pathname}))});
  if(action==='inspect')return inspect();
  if(action==='verifyPublished'){
   if(u.pathname!=='/jp/show/leavefeedback'||!document.body.innerText.includes('評価の変更'))throw Error('公開済み評価の表示を確認できません');
   const rows=[...document.querySelectorAll('td,div')].filter(visible).map(e=>n(e.innerText)).filter(t=>t.length<400&&t.includes('前回、評価した内容'));
   const expected=args.expectedComment??'ありがとうございました。';
   if(!['','ありがとうございました。'].includes(expected))throw Error('評価コメントの方針が不正です');
   const section=rows.find(t=>/評価\s+非常に良い\s+評価日時/.test(t)&&(expected?t.includes('コメント '+expected):/コメント\s*$/.test(t)));
   const date=section?.match(/評価日時\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(\d{1,2})時\s*(\d{1,2})分/);
   const revision=[...document.querySelectorAll('input[type="hidden"][name="isRevision"]')];
   if(!section||!date||!revision.length||revision.some(e=>!['1','true'].includes(e.value)))throw Error('前回の良い評価を一意に確認できません');
   const stamp=Date.parse(date[1]+'-'+date[2].padStart(2,'0')+'-'+date[3].padStart(2,'0')+'T'+date[4].padStart(2,'0')+':'+date[5].padStart(2,'0')+':00+09:00');
   if(!Number.isFinite(args.notBefore)||!Number.isFinite(stamp)||stamp<Math.floor(args.notBefore/60000)*60000||stamp>Date.now()+60000)throw Error('今回の評価日時と一致しません');
   return {success:true,pageUrl:u.href,positive:'非常に良い',comment:expected,reviewedAt:new Date(stamp).toISOString()};
  }
  if(['publishPreflight','publish'].includes(action)){
   if(u.pathname!=='/jp/preview/leavefeedback'||!document.body.innerText.includes('評価内容の確認')||!document.body.innerText.includes('出品者の評価'))throw Error('出品者評価の確認画面ではありません');
   const buttons=[...document.querySelectorAll('input[type="submit"],button[type="submit"]')].filter(e=>visible(e)&&n(e.value||e.innerText)==='評価を公開する');
   if(buttons.length!==1||buttons[0].disabled)throw Error('評価公開ボタンが一意ではありません');
   const button=buttons[0],form=button.form,post=form&&new URL(form.action),value=name=>form?.querySelector('input[type="hidden"][name="'+name+'"]')?.value;
   if(!form||form.method!=='post'||post.hostname!==u.hostname||post.pathname!=='/jp/submit/leavefeedback'||value('aID')!==itemId)throw Error('評価公開先・商品IDが一致しません');
   const expected=args.expectedComment??'ありがとうございました。';
   const storedComment=value('previewComment');let decodedComment=storedComment;try{decodedComment=decodeURIComponent(storedComment);}catch{}
   if(!['','ありがとうございました。'].includes(expected)||value('rating')!=='veryGood'||decodedComment!==expected){const error=Error('公開する評価またはコメントが方針と一致しません');error.values={rating:value('rating'),previewComment:storedComment,isBuyer:value('isBuyer'),isSeller:value('isSeller'),isRevision:value('isRevision')};throw error;}
   if(/^(true|1|yes)$/i.test(value('isSeller')||'')||/^(true|1|yes)$/i.test(value('isRevision')||''))throw Error('出品者側または変更評価のため停止しました');
   if(!['true','1'].includes(value('isBuyer')))throw Error('落札者としての評価を確認できません');
   if(action==='publishPreflight')return {readyToPublish:true,pageUrl:u.href,positive:'非常に良い',comment:expected};
   setTimeout(()=>button.click(),100);return {publishRequested:true,positive:'非常に良い',comment:expected};
  }
  if(action!=='preview'||u.pathname!=='/jp/show/leavefeedback')throw Error('未検証の評価操作を停止しました');
  if(!document.body.innerText.includes('評価の新規入力'))throw Error('新規評価画面ではありません');
  const rating=document.querySelector('select#rating[name="rating"]'),comment=document.querySelector('textarea#rate[name="formComment"]'),button=document.querySelector('input#decCheck[type="submit"]');
  if(!rating||!comment||!button||!visible(rating)||!visible(comment)||!visible(button)||rating.disabled||comment.disabled||button.disabled)throw Error('検証済み評価フォームが一致しません');
  const form=rating.form,actionUrl=form&&new URL(form.action);
  if(!form||comment.form!==form||button.form!==form||form.method!=='post'||actionUrl.hostname!==u.hostname||actionUrl.pathname!=='/jp/preview/leavefeedback'||n(button.value)!=='確認する')throw Error('評価確認先が一致しません');
  if(comment.value)throw Error('入力済みの評価コメントがあるため停止しました');
  const positive=[...rating.options].filter(o=>n(o.text)==='非常に良い'&&o.value==='veryGood');if(positive.length!==1)throw Error('良い評価の選択肢が一致しません');
  rating.value=positive[0].value;rating.dispatchEvent(new Event('change',{bubbles:true}));
  const commentRequired=comment.required||/コメント\s*[（(]必須[）)]/.test(n(comment.closest('tr')?.innerText));
  if(commentRequired){comment.value='ありがとうございました。';comment.dispatchEvent(new Event('input',{bubbles:true}));comment.dispatchEvent(new Event('change',{bubbles:true}));}
  if(!form.checkValidity())throw Error('未知の必須入力があるため停止しました');
  setTimeout(()=>button.click(),100);return {previewRequested:true,positive:'非常に良い',comment:comment.value};
 }catch(error){if(args.reportErrors)return {error:error.message,...(error.values?{values:error.values}:{})};throw error;}
}
