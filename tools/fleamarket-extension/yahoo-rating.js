export function yahooRatingPage(args){
 try{
  const {itemId,action='buyerPreflight'}=args,n=s=>(s||'').replace(/\s+/g,' ').trim(),u=new URL(location.href);
  if(action!=='buyerPreflight')throw Error('評価画面は読み取り専用です');
  const ids=new Set([...['aID','aid','auctionID','auctionId'].map(k=>u.searchParams.get(k)),...[...document.querySelectorAll('input[type="hidden"]')].filter(e=>/^(aid|auctionid)$/i.test(e.name)).map(e=>e.value)].filter(Boolean));
  if(u.hostname!=='auctions.yahoo.co.jp'||u.pathname!=='/jp/show/leavefeedback'||ids.size!==1||!ids.has(itemId))throw Error('出品者評価の商品ID・画面が一致しません');
  const visible=e=>e.getClientRects().length>0;
  if(action==='buyerPreflight'){
   const hidden=name=>[...document.querySelectorAll('input[type="hidden"]')].filter(e=>e.name===name).map(e=>e.value);
   const buyer=hidden('isBuyer').some(x=>['true','1'].includes(x)),seller=hidden('isSeller').some(x=>['true','1'].includes(x));
   if(!buyer||seller)throw Error('購入者としての評価フォームを確認できません');
   const revisionValues=[...new Set(hidden('isRevision').map(x=>String(x).trim().toLowerCase()).map(x=>x==='1'?'true':x==='0'?'false':x))];
   const revision=revisionValues.length===1?revisionValues[0]:null;
   const rating=document.querySelector('select#rating[name="rating"]'),comment=document.querySelector('textarea#rate[name="formComment"]'),button=document.querySelector('input#decCheck[type="submit"]');
   const form=rating?.form,formUrl=form?new URL(form.action):null;
   const newForm=Boolean(rating&&comment&&button&&visible(rating)&&visible(comment)&&visible(button)&&!rating.disabled&&!comment.disabled&&!button.disabled&&comment.form===form&&button.form===form&&form?.method==='post'&&formUrl?.hostname===u.hostname&&formUrl?.pathname==='/jp/preview/leavefeedback'&&n(button.value)==='確認する'&&[...rating.options].filter(o=>n(o.text)==='非常に良い'&&o.value==='veryGood').length===1&&!comment.value);
   const priorRatingText=document.body.innerText.includes('評価の変更')&&document.body.innerText.includes('前回、評価した内容');
   const evaluated=revision==='true'&&priorRatingText;
   // Yahoo's page copy changes between accounts. Treat a unique, explicit
   // isRevision=false plus the complete buyer evaluation form as new, instead
   // of depending on the exact heading text. Ambiguous/missing state still stops.
   const newHeading=document.body.innerText.includes('評価の新規入力');
   const newEvaluation=(revision==='false'||revision===''&&newHeading&&!priorRatingText)&&newForm;
   if(evaluated===newEvaluation){const error=Error('評価済みか新規評価かを一意に確認できません');error.values={revisionValues,hasNewEvaluationForm:newForm,priorRatingText,hasRating:!!rating,hasComment:!!comment,hasConfirm:!!button,commentEmpty:comment?.value==='',ratingVisible:!!rating&&visible(rating),commentVisible:!!comment&&visible(comment),buttonVisible:!!button&&visible(button),formMethod:form?.method||null,formPath:formUrl?.pathname||null,confirmLabel:n(button?.value),positiveOptions:rating?[...rating.options].filter(o=>n(o.text)==='非常に良い'&&o.value==='veryGood').length:0};throw error;}
   return {itemId,buyer:true,seller:false,evaluated,newEvaluation,observedAt:new Date().toISOString()};
  }
 }catch(error){if(args.reportErrors)return {error:error.message,...(error.values?{values:error.values}:{})};throw error;}
}
