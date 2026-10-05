import {API,PUBLIC_KEY} from './core.js';
let refreshPromise;
async function jsonRequest(path,options={}) {
  const r=await fetch(API+path,{...options,signal:AbortSignal.timeout(20000),headers:{apikey:PUBLIC_KEY,'Content-Type':'application/json',...options.headers}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.message||body.msg||body.error_description||body.error||`Supabase HTTP ${r.status}`);
  return body;
}
async function getToken(){
  let {session}=await chrome.storage.local.get('session');
  if(!session?.access_token) throw new Error('管理アプリとの初回連携が必要です');
  if(!session.expires_at||session.expires_at*1000<Date.now()+90000){
    if(!refreshPromise) refreshPromise=jsonRequest('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})})
      .then(async data=>{const clean={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+data.expires_in}; await chrome.storage.local.set({session:clean});return clean.access_token;})
      .finally(()=>{refreshPromise=null;});
    return refreshPromise;
  }
  return session.access_token;
}
export async function rpc(name,args={},token=null){
  if(!['is_admin','reconcile_marketplace_tracking','marketplace_extension_probe','marketplace_extension_receipt','extension_marketplace_message_queue','extension_claim_marketplace_message','extension_finish_marketplace_message','extension_sync_marketplace_messages','extension_sync_purchase_drafts','extension_probe_purchase_item'].includes(name)) throw new Error('許可されていない登録処理です');
  return jsonRequest('/rest/v1/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+(token||await getToken()),'Content-Profile':'app','Accept-Profile':'app'},body:JSON.stringify(args)});
}
export async function connectSession(data) {
  if(!data?.access_token||!data?.refresh_token) throw new Error('管理アプリにログインしてから再度連携してください');
  if(await rpc('is_admin',{},data.access_token)!==true) throw new Error('管理者アカウントでの連携が必要です');
  await chrome.storage.local.set({session:{access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||0}});
  return {connected:true};
}
