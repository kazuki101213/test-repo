import {getSupabase} from './supabase';
export type AccessoryUsageContext={serial:string;revision:string;sku:string};
export async function fetchAccessoryUsage(itemId:string):Promise<AccessoryUsageContext>{
 const {data,error}=await getSupabase().rpc('accessory_usage_context',{p_item_id:itemId});
 if(error)throw error;return data as AccessoryUsageContext;
}
export async function reassignAccessoryUsage(itemId:string,serial:string,revision:string):Promise<{item_id:string;serial:string;sku:string}>{
 const normalized=serial.trim().toLowerCase();
 if(!/^[1-9][0-9]*[a-z]*$/.test(normalized))throw new Error('使用先の通番号を入力してください');
 const {data,error}=await getSupabase().rpc('reassign_accessory_usage',{p_item_id:itemId,p_serial:normalized,p_expected_revision:revision});
 if(error)throw error;return data;
}
