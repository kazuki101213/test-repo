import { getSupabase } from './supabase';
import { mergeInventoryPage, type InventorySnapshot } from './inventorySync';

type Entry = { rows: {id:string}[]; known: Record<string,string>; checked: number };
const cache = new Map<string,Entry>();
const pending = new Map<string,Promise<{id:string}[]>>();
/** Always revalidate; cache only avoids resending unchanged rows. Scoped to the login user. */
export async function readResourceSnapshot<T extends {id:string}>(resource:string, filters:Record<string,unknown>={}):Promise<T[]> {
 const sb=getSupabase();
 const {data:session,error:sessionError}=await sb.auth.getSession();
 if(sessionError)throw sessionError;
 const user=session.session?.user.id;
 if(!user)throw new Error('ログインしてください。');
 const key=JSON.stringify([user,resource,filters]);
 const running=pending.get(key);if(running)return running as Promise<T[]>;
 const request=(async()=>{
  const old=cache.get(key);
  const previous=old&&Date.now()-old.checked<300000?old:undefined;
  const {data,error}=await sb.rpc('read_resource_snapshot',{p_resource:resource,p_filters:filters,p_known:previous?.known??{}});
  if(error)throw error;
  const snapshot=data as InventorySnapshot<T>;
  const rows=mergeInventoryPage((previous?.rows??[]) as T[],snapshot);
  const known=snapshot.unchanged?previous!.known:{...snapshot.fingerprints,__revision:snapshot.revision!};
  cache.delete(key);cache.set(key,{rows,known,checked:Date.now()});
  while(cache.size>12)cache.delete(cache.keys().next().value!);
  return rows;
 })();
 pending.set(key,request);
 try{return await request;}finally{if(pending.get(key)===request)pending.delete(key);}
}
