import {sellerAccounts} from './seller-sync.js?v=0.1.143';
import {sellerQueuedOperations} from './seller-runtime.js?v=0.1.143';

// Called only after a real patrol. Existing claims guard every marketplace
// action; this path can execute shipping_code only, never listing/ship_notice.
export async function processLineShipping(dependencies){
 const {settings,rpc,log}=dependencies,accounts=sellerAccounts(settings);
 if(settings.mode==='diagnostic'||!accounts.length)return;
 const result=await rpc('extension_prepare_line_shipping',{p_account_ids:accounts.map(a=>a.id)});
 const count=Math.min(20,Math.max(0,Number(result?.automaticPending??result?.queued)||0));
 for(let n=0;n<count;n++){
  const operation=await sellerQueuedOperations({...dependencies,onlyAutomaticLine:true});
  if(!operation?.processed)break;
  if(operation.status!=='succeeded')await log('warning','LINE発送依頼：発送コードを取得できない商品があります。アプリの発送画面で確認してください。');
 }
}


// Keep the request across early returns and service-worker suspension.
// These times identify the scheduled slot, never a marketplace transaction.
export async function markLinePatrolDue(storage, scheduledAt) {
 const {linePatrolDueAt = 0} = await storage.get('linePatrolDueAt');
 if (Number.isFinite(scheduledAt) && scheduledAt > linePatrolDueAt) {
  await storage.set({linePatrolDueAt:scheduledAt});
 }
}

export async function runLinePatrol(dependencies, {pendingOnly=false,run=processLineShipping,now=Date.now} = {}) {
 const {storage}=dependencies;
 const {linePatrolDueAt=0,linePatrolDoneAt=0,linePatrolAttemptAt=0}=await storage.get(['linePatrolDueAt','linePatrolDoneAt','linePatrolAttemptAt']);
 const pending=linePatrolDueAt>linePatrolDoneAt;
 if(pendingOnly&&(!pending||now()-linePatrolAttemptAt<5*60000))return false;
 if(pending)await storage.set({linePatrolAttemptAt:now()});
 await run(dependencies);
 if(pending)await storage.set({linePatrolDoneAt:linePatrolDueAt});
 return true;
}
