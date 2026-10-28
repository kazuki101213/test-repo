// Only the site/account policy and durable receipt reservation may invoke this flow.
export async function yahooEvaluationFlow({itemId,contact,rating,go,settle,assertEligible,alreadyReceived=false,alreadyOnRatingPage=false,ratingUrl=null}){
 const startedAt=Date.now();
 const checked=async promise=>{const value=await promise;if(value?.error)throw Error(value.error);if(!value)throw Error('評価画面から結果が返りません');return value;};
 if(!alreadyReceived){const received=await checked(contact({itemId,action:'receive'}));if(!received.received)throw Error('受取連絡後の完了を確認できません');}
 const link=alreadyOnRatingPage?{url:ratingUrl}:await checked(contact({itemId,action:'ratingLink'}));if(!link.url)throw Error('出品者評価へのリンクがありません');
 if(!alreadyOnRatingPage)await go(link.url);
 const buyer=await checked(rating({itemId,action:'buyerPreflight'}));
 if(!buyer.buyer||buyer.seller||buyer.evaluated||!buyer.newEvaluation)throw Error('購入者の未評価フォームを確認できません');
 const preview=await checked(rating({itemId,action:'preview'}));if(!preview.previewRequested)throw Error('評価確認を開始できません');
 await settle();
 const args={itemId,expectedComment:preview.comment};
 const ready=await checked(rating({...args,action:'publishPreflight'}));if(!ready.readyToPublish)throw Error('評価公開の内容を確認できません');
 await assertEligible();
 const publication=await checked(rating({...args,action:'publish'}));if(!publication.publishRequested)throw Error('評価公開を開始できません');
 await settle();
 const response=await checked(rating({itemId,action:'submissionResult'}));if(!response.submissionResult)throw Error('評価公開後の応答画面を確認できません');
 await go(link.url);
 const result=await checked(rating({...args,notBefore:startedAt,action:'verifyPublished'}));if(!result.success)throw Error('評価公開後の完了を確認できません');
 return {success:true};
}
