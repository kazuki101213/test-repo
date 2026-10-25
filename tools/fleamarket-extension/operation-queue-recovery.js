// Retry queue discovery on later alarms, never replay a claimed operation.
// The workers retain their atomic claim and uncertain-result guards.
import {IDLE_CHECK_MINUTES} from './runtime-policy.js';
const delays=[300000,600000,900000,1800000];
export async function runOperationQueue({scope,storage,run,log,now=Date.now()}){
 const key=scope==='supplier'?'supplierQueueRecovery':'sellerQueueRecovery';
 const previous=(await storage.get(key))[key];
 if(Number(previous?.nextAttemptAt)>now)return false;
 try{
  await run();
  await storage.set({[key]:{failures:0,checkedAt:new Date(now).toISOString(),nextAttemptAt:now+IDLE_CHECK_MINUTES*60000}});
  if(previous?.failures)await log('info',scope==='supplier'?'仕入先の操作取得が復旧しました':'販売操作の取得が復旧しました',{scope,previousFailures:previous.failures});
  return true;
 }catch(error){
  const failures=Math.min((Number(previous?.failures)||0)+1,1000);
  const delay=delays[Math.min(failures-1,delays.length-1)];
  // Only allowlisted RPC names/transport fields, never arguments, headers or tokens.
  const diagnostic=error?.requestDiagnostic||{};
  const state={failures,failedAt:new Date(now).toISOString(),nextAttemptAt:now+delay,
   rpc:/^[a-z_]+$/.test(error?.rpcName||'')?error.rpcName:null,
   failure:['network','timeout','aborted','http','invalid_response'].includes(diagnostic.failure)?diagnostic.failure:'unknown',
   status:Number.isInteger(diagnostic.status)?diagnostic.status:null,
   elapsedMs:Number.isFinite(diagnostic.elapsedMs)?diagnostic.elapsedMs:null};
  await storage.set({[key]:state});
  await log('warning',(scope==='supplier'?'仕入先':'販売')+'の操作取得で通信または応答エラー。'+delay/60000+'分後に取得を再確認します。実行済み操作は再送しません',{scope,...state});
  return false;
 }
}

// Drain only an explicitly confirmed shipment batch; other actions retain one-per-check behavior.
export async function drainConfirmedShippingQueue(run){
 let last;
 for(let n=0;n<3;n++){last=await run();if(!last?.processed||last.status!=='succeeded'||last.kind!=='ship_notice'||last.confirmedShippingPending!==true)break;}
 return last;
}
