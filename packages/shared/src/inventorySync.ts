import {getSupabase} from './supabase';
import {staffDisplayName} from './staffNames';
export type InventoryScope='delivery'|'management';
export interface InventorySnapshot<T>{rows:T[];ids:string[];fingerprints:Record<string,string>;total:number;unchanged?:boolean;revision?:string}
export interface InventoryPage<T>{rows:T[];fingerprints:Record<string,string>;total:number;limit:number;checkedAt:number}
export function mergeInventoryPage<T extends {id:string}>(previous:T[],snapshot:InventorySnapshot<T>):T[]{
 if(snapshot.unchanged)return previous;
 const rows=new Map(previous.map(row=>[row.id,row]));
 for(const row of snapshot.rows)rows.set(row.id,row);
 return snapshot.ids.map(id=>{const row=rows.get(id);if(!row)throw new Error('在庫の差分を復元できません。再読み込みしてください。');return row;});
}
const cache=new Map<string,InventoryPage<{id:string}>>();
export function cachedInventoryPage<T extends {id:string}>(key:string):InventoryPage<T>|undefined{
 const page=cache.get(key);if(!page||Date.now()-page.checkedAt>300000){cache.delete(key);return undefined;}return page as InventoryPage<T>;
}
export function rememberInventoryPage<T extends {id:string}>(key:string,page:InventoryPage<T>){
 cache.delete(key);cache.set(key,page);while(cache.size>8)cache.delete(cache.keys().next().value!);
}
export async function fetchInventoryPage<T extends {id:string}>(scope:InventoryScope,filters:Record<string,unknown>,limit:number,known:Record<string,string>={},signal?:AbortSignal):Promise<InventorySnapshot<T>>{
 if(filters.from&&filters.to&&String(filters.from)>String(filters.to))throw new Error('仕入日の終了日は、開始日以降の日付を選んでください。');
 let request=getSupabase().rpc('read_inventory_page',{p_scope:scope,p_filters:filters,p_limit:limit,p_known:known});
 if(signal)request=request.abortSignal(signal);
 const {data,error}=await request;if(error)throw error;
 const snapshot=data as InventorySnapshot<T>;
 if(scope==='delivery')snapshot.rows=snapshot.rows.map(row=>{const task=row as T & {deliverer_name?:string|null};return {...row,deliverer_name:staffDisplayName(task.deliverer_name)};});
 return snapshot;
}
export async function fetchCompleteInventory<T extends {id:string}>(scope:InventoryScope,filters:Record<string,unknown>):Promise<T[]>{
 const page=await fetchInventoryPage<T>(scope,filters,10000);
 if(page.total>10000)throw new Error('対象が多いため、条件を絞り込んでから再実行してください。');
 return mergeInventoryPage([],page);
}
