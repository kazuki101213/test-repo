// Local operator request: import purchase history only, once, without changing schedules.
export function purchaseRefreshAccounts(request,profileId,previous,settings,now=Date.now()) {
 const issued=Date.parse(request?.issuedAt),expires=Date.parse(request?.expiresAt);
 if(request?.kind!=='purchase-refresh'||!/^[a-f0-9-]{36}$/.test(request.id||'')||request.id===previous
  ||!Array.isArray(request.profiles)||!request.profiles.includes(profileId)
  ||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now||expires<=now||expires-issued>15*60000
  ||!Array.isArray(request.accounts)||!request.accounts.length||new Set(request.accounts).size!==request.accounts.length
  ||request.accounts.some(id=>!['auctions-1','auctions-2'].includes(id))
  ||settings.mode==='diagnostic'||settings.purchaseImportEnabled!==true)return [];
 return settings.accounts.filter(a=>a.enabled&&a.site==='auctions'&&request.accounts.includes(a.id)).map(a=>a.id);
}
export async function runPurchaseRefresh({request,profileId,storage,settings,busy,start,log=async()=>{},now=Date.now()}) {
 if(busy)return false;
 const state=await storage.get(['job','lastPurchaseRefreshRequest','authProblem']);
 if(state.job||state.authProblem)return false;
 const accounts=purchaseRefreshAccounts(request,profileId,state.lastPurchaseRefreshRequest,settings,now);
 if(!accounts.length)return false;
 // Consume before starting; failures are reported and never automatically replayed.
 await storage.set({lastPurchaseRefreshRequest:request.id});
 try{await start('purchases',true,accounts);await log('info','仕入れリストの購入履歴を再取得します',{accounts});}
 catch(error){await log('error','仕入れリスト再取得: '+error.message);}
 return true;
}
