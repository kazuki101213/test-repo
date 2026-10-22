/** Manual app requests reuse only the existing purchases engine. No new tabs or schedules. */
export async function processPurchaseSync({storage,rpc,settings,profileId,busy,start,now=Date.now()}){
 const state=await storage.get(['purchaseSyncActive','job','lastRun','authProblem','session','operationPolicy','purchaseSyncPollAt']);
 if(state.authProblem||!state.session||!profileId)return;
 let active=state.purchaseSyncActive;
 if(active){
  if(state.job?.id===active.jobId)return;
  if(state.job)return;
  const last=state.lastRun?.purchases,complete=last?.id===active.jobId;
  const counts=complete?last.counts:{};
  await rpc('purchase_sync',{p_action:'finish',p_request_id:active.requestId,p_profile_id:profileId,p_claim_token:active.token,p_result:{imported:counts?.imported||0,errors:complete?(counts?.errors||0):1,note:complete?(counts?.errors?'一部のアカウントで停止しました。確認タスク・拡張機能の実行記録を確認してください':'購入履歴の同期が完了しました'):'同期が中断されたか開始できませんでした。再送していません'}});
  await storage.set({purchaseSyncActive:null});return;
 }
 if(busy||state.job||settings.mode==='diagnostic'||state.operationPolicy&&!state.operationPolicy.includes('purchases'))return;
 if(now-(state.purchaseSyncPollAt||0)<55000)return;
 await storage.set({purchaseSyncPollAt:now});
 const request=await rpc('purchase_sync',{p_action:'claim',p_profile_id:profileId});if(!request)return;
 const actual=settings.accounts.filter(a=>a.enabled).map(a=>a.id).sort(),wanted=[...(request.accounts||[])].sort();
 active={requestId:request.requestId,token:request.token,jobId:crypto.randomUUID()};
 await storage.set({purchaseSyncActive:active});
 if(request.profileId!==profileId||!wanted.length||JSON.stringify(actual)!==JSON.stringify(wanted)||Date.parse(request.expiresAt)<=now){
  await rpc('purchase_sync',{p_action:'finish',p_request_id:request.requestId,p_profile_id:profileId,p_claim_token:request.token,p_result:{errors:1,note:'登録アカウントまたは同期期限が一致しません'}});await storage.set({purchaseSyncActive:null});return;
 }
 try{await start('purchases',true,wanted,active.jobId);}
 catch(error){await rpc('purchase_sync',{p_action:'finish',p_request_id:request.requestId,p_profile_id:profileId,p_claim_token:request.token,p_result:{errors:1,note:'購入履歴の同期を開始できません：'+String(error.message).slice(0,300)}});await storage.set({purchaseSyncActive:null});}
}
