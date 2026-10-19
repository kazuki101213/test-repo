import {getSupabase} from '@bussan/shared';

type Photo={id:string;url:string};
export async function readReviewPhotos(itemId:string){
 const sb=getSupabase();
 const [owned,listed]=await Promise.all([
  sb.from('item_photos').select('id').eq('item_id',itemId).or('photo_kind.eq.product,photo_kind.is.null').order('created_at').order('id'),
  sb.functions.invoke('delivery-photo-drive',{body:{itemId,action:'list',purpose:'product'}}),
 ]);
 if(owned.error)throw owned.error;
 if(listed.error)throw listed.error;
 if(!Array.isArray(listed.data?.photos)||typeof listed.data?.lotSeq!=='number')throw Error('商品写真を取得できませんでした。');
 const lotPhotos=listed.data.photos as Photo[];
 const byId=new Map(lotPhotos.map(photo=>[photo.id,photo.url]));
 const photos=(owned.data??[]).map(photo=>{
  const url=byId.get(photo.id);
  if(!url)throw Error('商品写真の一部を読み込めませんでした。もう一度確認画面を開いてください。');
  return url;
 });
 return {photos,lotPhotos,lotSeq:listed.data.lotSeq as number};
}
