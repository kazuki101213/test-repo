import {getSupabase} from './supabase';
import {sharedReadCache} from './readCache';
export async function sessionRead<T>(key:string,ttl:number,load:(user:string)=>Promise<T>):Promise<T>{
 const {data,error}=await getSupabase().auth.getSession();if(error)throw error;
 const user=data.session?.user.id;if(!user)throw new Error('ログインしてください。');
 return sharedReadCache.read(user,key,ttl,()=>load(user));
}
