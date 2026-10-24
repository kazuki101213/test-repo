import {validPurchaseTitle} from './purchase-title.js';
import {API,PUBLIC_KEY} from './core.js';
let refreshPromise;
export const AUTH_BLOCKED='管理アプリとの連携認証が切れています。管理アプリにログインして再連携してください';
async function jsonRequest(path,options={}) {
  const started=Date.now();let status=null;
  try{
    const r=await fetch(API+path,{...options,signal:AbortSignal.timeout(20000),headers:{apikey:PUBLIC_KEY,'Content-Type':'application/json',...options.headers}});
    status=Number.isInteger(r.status)?r.status:null;
    if(r.status===204)return null;
    let body;try{body=await r.json();}catch{const error=new Error('Supabaseの応答形式を確認できません');error.responseInvalid=true;throw error;}
    if(!r.ok)throw new Error(body.message||body.msg||body.error_description||body.error||`Supabase HTTP ${r.status}`);
    return body;
  }catch(error){
    const failure=status!==null&&!error.responseInvalid?'http':error.responseInvalid?'invalid_response':error.name==='TimeoutError'?'timeout':error.name==='AbortError'?'aborted':'network';
    error.requestDiagnostic={failure,status,elapsedMs:Date.now()-started};
    if(path.startsWith('/rest/v1/rpc/'))error.rpcName=path.split('/').at(-1);
    else error.rpcName='auth_refresh';
    throw error;
  }
}
async function getToken(){
  const {session,authProblem}=await chrome.storage.local.get(['session','authProblem']);
  if(authProblem)throw new Error(AUTH_BLOCKED);
  if(!session?.access_token) throw new Error('管理アプリとの初回連携が必要です');
  if(!session.expires_at||session.expires_at*1000<Date.now()+90000){
    if(!refreshPromise) refreshPromise=jsonRequest('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})})
      .then(async data=>{const clean={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+data.expires_in}; await chrome.storage.local.set({session:clean});return clean.access_token;})
      .catch(async e=>{if(/Invalid Refresh Token|refresh_token_not_found|refresh_token_already_used|Session.*not found/i.test(e.message)){await chrome.storage.local.set({authProblem:{at:new Date().toISOString(),reason:'refresh-invalid'}});throw new Error(AUTH_BLOCKED);}throw e;})
      .finally(()=>{refreshPromise=null;});
    return refreshPromise;
  }
  return session.access_token;
}
export async function rpc(name,args={},token=null){
  const lineAllowed=name==='extension_prepare_line_shipping';
  if(!lineAllowed&&!['purchase_sync','extension_daily_shipping_candidates','extension_claim_daily_shipping_notice','seller_feedback_candidates','seller_feedback_record','extension_supplier_queue','extension_claim_supplier_operation','extension_finish_supplier_operation','extension_seller_daily_barrier','seller_sync_context','seller_observation_plan','sync_seller_observation','extension_seller_queue','extension_claim_seller_operation','extension_finish_seller_operation','extension_claim_listing_result_check','extension_finish_listing_result_check','sync_marketplace_sale_status','marketplace_purchase_lease','marketplace_purchase_context','marketplace_purchase_import','marketplace_extension_runtime_report','marketplace_tracking_candidates','is_admin','reconcile_marketplace_tracking','marketplace_extension_probe','marketplace_extension_receipt','extension_marketplace_message_queue','extension_claim_marketplace_message','extension_finish_marketplace_message','extension_sync_marketplace_messages','extension_sync_purchase_drafts'].includes(name)) throw new Error('許可されていない登録処理です');
  if(['marketplace_purchase_import','extension_sync_purchase_drafts'].includes(name)&&Array.isArray(args.p_purchases)&&args.p_purchases.some(row=>!validPurchaseTitle(row?.title)))throw new Error('商品名が通知文・操作案内等、または未確認のため保存を停止しました');
  const options={method:'POST',headers:{Authorization:'Bearer '+(token||await getToken()),'Content-Profile':'app','Accept-Profile':'app'},body:JSON.stringify(args)};try{return await jsonRequest('/rest/v1/rpc/'+name,options);}catch(e){if(!['marketplace_purchase_context','marketplace_purchase_import','marketplace_purchase_lease'].includes(name)||!/Failed to fetch|signal timed out|timeout|aborted|HTTP 50[234]/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,3000));return jsonRequest('/rest/v1/rpc/'+name,options);}
}
export async function connectSession(data) {
  if(!data?.access_token||!data?.refresh_token) throw new Error('管理アプリにログインしてから再度連携してください');
  if(await rpc('is_admin',{},data.access_token)!==true) throw new Error('管理者アカウントでの連携が必要です');
  await chrome.storage.local.set({session:{access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||0}});
  await chrome.storage.local.remove(['authProblem','authRecoveryAttempt']);
  return {connected:true};
}
