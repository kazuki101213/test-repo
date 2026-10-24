import {processSellerFeedback} from './seller-feedback.js';
import {parseSellerSaleDetail} from './seller-sync.js?v=0.1.143';
// Explicit expired-by-default request. It does not enable or reset any daily/hourly sender.
export async function runSellerFeedbackRepair(dependencies){
 const {settings,records,profileId,storage,fetchRequest,rpc,openSession,log}=dependencies,request=await fetchRequest(),map={'f29f12b6-35f2-4e9f-8312-a8321ddf3c12':'mercari-1','51502a66-28a6-4af0-81ea-660e63d8b66c':'mercari-2'};
 if(!request||request.kind!=='seller-feedback-repair'||!/^[-0-9a-f]{36}$/i.test(request.id||'')||request.profileId!==profileId||map[profileId]!==request.accountId)return false;
 const now=Date.now(),issued=Date.parse(request.issuedAt),expires=Date.parse(request.expiresAt),targets=request.targets;
 if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>15*60000||!Array.isArray(targets)||!targets.length||targets.length>12||new Set(targets.map(t=>t.itemId)).size!==targets.length||!targets.every(t=>/^m[0-9]{8,14}$/.test(t.itemId||'')&&/^[0-9]{1,8}[a-z]{0,3}$/.test(t.serial||'')))return false;
 if(settings.mode==='diagnostic'||records.job||records.authProblem||!records.session?.access_token||!dependencies.feedbackSites?.includes('mercari'))return false;
 const account=settings.accounts.find(a=>a.enabled&&a.id===request.accountId&&a.site==='mercari');if(!account)return false;
 const saved=await storage.get(['sellerInspectionEvidence','sellerFeedbackRepairConsumed']),proof=saved.sellerInspectionEvidence,done=saved.sellerFeedbackRepairConsumed||[];
 if(done.includes(request.id)||proof?.requestId!==request.preflightRequestId||proof.accountId!==account.id||proof.readOnly!==true||proof.status!=='completed'||!Number.isFinite(Date.parse(proof.at))||now-Date.parse(proof.at)<0||now-Date.parse(proof.at)>15*60000||!targets.every(t=>proof.feedback?.some(p=>p.itemId===t.itemId&&p.serial===t.serial&&!p.error&&p.preflight?.ready===true)))return false;
 await storage.set({sellerFeedbackRepairConsumed:[...done,request.id].slice(-32),sellerFeedbackRepairAttempt:{id:request.id,status:'running',at:new Date().toISOString(),accountId:account.id,total:targets.length}});
 let session;const financialFailures=[];let result={rated:0,errors:0};
 try{
  session=await openSession(account);
  const rows=targets.map(t=>({external_id:t.itemId,serial:t.serial,status:'取引中',feedback_pending:true}));
  const plans=await rpc('seller_feedback_candidates',{p_account_id:account.id,p_ids:rows.map(r=>r.external_id)});
  if(!Array.isArray(plans)||!targets.every(t=>plans.some(p=>p.external_id===t.itemId&&p.sku?.split('-')[0].toLowerCase()===t.serial&&!p.state)))throw Error('評価対象の在庫・予約状態が変わったため停止しました');
  result=await processSellerFeedback({account,rows,session,rpc,storage,log,now});
  const checks=(await storage.get('sellerFeedbackChecks')).sellerFeedbackChecks||{};
  for(const target of targets){if(checks[account.id+':'+target.itemId]?.state!=='succeeded')continue;try{const detail=await session.detail('https://jp.mercari.com/transaction/'+target.itemId,target.itemId),extra=parseSellerSaleDetail('メルカリ',detail.text,target.itemId,detail.url);const response=await rpc('sync_seller_observation',{p_account_id:account.id,p_observation:{external_id:target.itemId,serial:target.serial,status:'販売済',...extra,trade_url:detail.url,observed_at:new Date().toISOString()}});if(!['registered','updated'].includes(response))financialFailures.push({itemId:target.itemId,reason:response});}catch(error){financialFailures.push({itemId:target.itemId,reason:error.message});}}
  await storage.set({sellerFeedbackRepairAttempt:{id:request.id,accountId:account.id,total:targets.length,...result,financialFailures,status:result.rated===targets.length&&!result.errors&&!financialFailures.length?'completed':'needs-review',at:new Date().toISOString()}});
 }catch(error){await storage.set({sellerFeedbackRepairAttempt:{id:request.id,accountId:account.id,total:targets.length,...result,status:'failed',error:error.message,financialFailures,at:new Date().toISOString()}});await log('error','購入者評価の補修を停止しました。自動再送しません：'+error.message);}finally{await session?.close();}
 return true;
}
