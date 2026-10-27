import {parseSellerSaleDetail} from './seller-sync.js?v=0.1.143';
export function validSaleRepairTargets(request,account){return account?.site==='mercari'&&Array.isArray(request.targets)&&request.targets.length>0&&request.targets.length<=12&&new Set(request.targets.map(t=>t.itemId)).size===request.targets.length&&request.targets.every(t=>/^m[0-9]{8,14}$/.test(t.itemId||'')&&/^[0-9]{1,8}[a-z]{0,3}$/.test(t.serial||''));}
export async function repairCompletedTargetSales({request,account,openSession,rpc,storage,log}){
 if(!validSaleRepairTargets(request,account))throw Error('Invalid completed-sale repair targets');
 let session,updated=0;const failures=[];
 try{session=await openSession(account);for(const target of request.targets){try{
  if(Date.now()>Date.parse(request.expiresAt))throw Error('Completed-sale repair expired');
  const url='https://jp.mercari.com/transaction/'+target.itemId;await session.go(url);
  const proof=await session.feedback({...target,action:'inspect'});if(proof.alreadyCompleted!==true)throw Error('Native transaction is not completed');
  const detail=await session.detail(url,target.itemId),extra=parseSellerSaleDetail('\u30e1\u30eb\u30ab\u30ea',detail.text,target.itemId,detail.url);
  const result=await rpc('sync_seller_observation',{p_account_id:account.id,p_observation:{external_id:target.itemId,serial:target.serial,status:'\u8ca9\u58f2\u6e08',...extra,trade_url:detail.url,observed_at:new Date().toISOString()}});
  if(!['registered','updated'].includes(result))throw Error('Sale reconciliation did not apply: '+result);updated++;
 }catch(error){failures.push({itemId:target.itemId,error:error.message});if(/\u30ed\u30b0\u30a4\u30f3|\u8a8d\u8a3c|\u540d\u524d|URL/.test(error.message))break;}}
 }catch(error){failures.push({error:error.message});}finally{await session?.close();}
 await storage.set({sellerRepairAttempt:{requestId:request.id,accountId:account.id,targets:request.targets.map(t=>t.itemId),status:failures.length?'failed':'completed',updated,errors:failures.length,failures,at:new Date().toISOString()}});
 if(failures.length)await log('error','Completed-sale reconciliation needs review',{failures});return {updated,errors:failures.length};
}
