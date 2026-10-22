import { getSupabase } from '@bussan/shared';
export type PurchaseSyncProfile = { profileId: string; accounts: string[]; status: 'queued'|'running'|'completed'|'failed'|'expired'; result: { imported?: number; errors?: number; note?: string } };
export type PurchaseSyncStatus = { requestId: string|null; profiles: PurchaseSyncProfile[] };
export async function fetchPurchaseSync(): Promise<PurchaseSyncStatus> {
 const {data,error}=await getSupabase().rpc('purchase_sync',{p_action:'status'});if(error)throw error;return data as PurchaseSyncStatus;
}
export async function requestPurchaseSync(id: string): Promise<PurchaseSyncStatus> {
 const {data,error}=await getSupabase().rpc('purchase_sync',{p_action:'request',p_request_id:id});if(error)throw error;return data as PurchaseSyncStatus;
}
export function purchaseSyncSummary(status: PurchaseSyncStatus|null) {
 const profiles=status?.profiles||[],active=profiles.some(p=>p.status==='queued'||p.status==='running');
 const total=profiles.reduce((n,p)=>n+p.accounts.length,0),finished=profiles.filter(p=>['completed','failed','expired'].includes(p.status)).reduce((n,p)=>n+p.accounts.length,0);
 const imported=profiles.reduce((n,p)=>n+(p.result.imported||0),0),problems=profiles.filter(p=>p.status==='failed'||p.status==='expired');
 const note=problems.map(p=>p.status==='expired'?'Chromeが応答せず同期期限を過ぎました。別PCのChromeを確認してください。':p.result.note||'取得を停止しました。確認タスクを確認してください。').filter((v,i,a)=>a.indexOf(v)===i).join(' ');
 return {active,fingerprint:JSON.stringify(profiles.map(p=>[p.profileId,p.status,p.result])),message:!profiles.length?'':active?'フリマサイトと同期中（'+finished+'/'+total+'アカウント終了・追加'+imported+'件）。別の処理中やChromeが閉じている場合は待機します。':problems.length?'同期の一部が停止しました（追加'+imported+'件）。'+note:'同期完了（'+total+'アカウント・追加'+imported+'件）'};
}
