import {getSupabase} from '@bussan/shared';
import type {DeliveryTask} from '@bussan/shared';

export const RECORDER_MALFUNCTION_NOTE = [
 '◯×当てはまる方。詳しく文章で。',
 '地上波受信◯×',
 '地上波録画◯×',
 'ディスク開閉◯×',
 'BD再生◯×',
 'DVD再生◯×',
 '初期化◯×',
 'リモコン操作◯×',
 'リモコン発光◯×',
].join('\n');

export async function initialMalfunctionNote(task:Pick<DeliveryTask,'asin'|'is_accessory'>):Promise<string>{
 if(task.is_accessory||!task.asin)return '';
 const {data,error}=await getSupabase().from('products').select('shipping_category')
  .eq('asin',task.asin).eq('is_active',true).maybeSingle();
 if(error)throw error;
 return data?.shipping_category==='ブ'?RECORDER_MALFUNCTION_NOTE:'';
}
