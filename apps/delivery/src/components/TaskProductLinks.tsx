import {noticeProductUrl,type TaskPurchaseProduct} from '@bussan/shared';
type Reference={marketplace?:string|null;marketplace_item_id?:string|null;marketplace_url?:string|null};
export default function TaskProductLinks({products,fallback}:{products?:TaskPurchaseProduct[];fallback:Reference}){
 const entries:((Reference)&{id:string;is_accessory?:boolean;title?:string})[]=products?.length?products:[{...fallback,id:'fallback'}];
 return <span className="task-product-links">{entries.map(item=>{
  const id=item.marketplace_item_id?.trim()||'商品ID未登録';
  const url=noticeProductUrl(item.marketplace??null,item.marketplace_item_id??null,item.marketplace_url??null);
  const label=(item.is_accessory?'付属品':'本体')+'の商品ページを開く：'+id;
  return url?<a key={item.id} href={url} target="_blank" rel="noopener noreferrer" aria-label={label} title={item.title}>【{id}】</a>:<span key={item.id} title={item.title}>【{id}】</span>;
 })}</span>;
}
