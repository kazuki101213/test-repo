// Internal recovery of explicitly reviewed photos from the current sold listing.
// Authentication is the existing private dispatcher secret, never a public route.
export async function recoverListingPhotoFiles({admin,itemId,sources,fetcher=fetch}:{admin:any;itemId:string;sources:string[];fetcher?:typeof fetch}) {
 if(!/^[0-9a-f-]{36}$/.test(itemId)||!Array.isArray(sources)||sources.length!==2||new Set(sources).size!==2)throw Error('写真の対象を確認してください');
 const item=await admin.from('items').select('id,sku,status,shipped_on,sold_on,seller_trade_key').eq('id',itemId).maybeSingle();
 if(item.error||!item.data||item.data.status!=='取引中'||item.data.shipped_on||item.data.sold_on||!/^[0-9a-zA-Z-]{1,120}$/.test(item.data.sku))throw Error('未発送の取引商品のみ復旧できます');
 const listing=await admin.from('seller_listings').select('external_id,trade_key').eq('item_id',itemId).eq('active',true).eq('channel','メルカリ').maybeSingle();
 if(listing.error||!/^m[0-9]+$/.test(listing.data?.external_id)||listing.data.trade_key!==item.data.seller_trade_key)throw Error('現在のメルカリ取引を確認できません');
 const photos=await admin.from('item_photos').select('id').eq('item_id',itemId).limit(1);
 if(photos.error||photos.data?.length)throw Error('既存の商品写真は上書きしません');
 const urls=sources.map(source=>{const url=new URL(source);const match=new RegExp('^/item/detail/orig/photos/'+listing.data.external_id+'_([1-9]|1[0-9]|20)\\.jpg$').exec(url.pathname);
  if(url.protocol!=='https:'||url.hostname!=='static.mercdn.net'||url.username||url.password||url.port||url.hash||!match||url.search&&!/^\?[0-9]{1,16}$/.test(url.search))throw Error('この出品の商品写真のみ復旧できます');
  return{url:url.href,index:match[1]};});
 if(new Set(urls.map(value=>value.index)).size!==2)throw Error('異なる2枚を指定してください');
 const files=[];
 for(const source of urls){const response=await fetcher(source.url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='image/jpeg')throw Error('出品写真を取得できません');
  const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length<4||bytes.length>4*1024*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw Error('出品写真の形式・容量を確認してください');
  files.push({path:`${item.data.sku}/mercari-${listing.data.external_id}-${source.index}.jpg`,bytes});
 }
 for(const file of files){const result=await admin.storage.from('item-photos').upload(file.path,file.bytes,{contentType:'image/jpeg',cacheControl:'3600',upsert:false});if(result.error)throw Error('写真の保存に失敗しました。再試行前に保存状況を確認してください');}
 return{itemId,paths:files.map(file=>file.path)};
}
