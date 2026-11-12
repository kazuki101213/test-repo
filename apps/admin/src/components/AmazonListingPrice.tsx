import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';
export type ListingPrice={id:string;sku:string;accountId?:'amazon-1'|'amazon-2';price:number|null;error?:string};
const pending=new Map<string,Array<{resolve:(row:ListingPrice)=>void;reject:(e:Error)=>void}>>();
let timer:ReturnType<typeof setTimeout>|undefined;
async function invoke(body:object){
 const {data,error}=await getSupabase().functions.invoke('amazon-listing-price',{body});
 if(error){const response=error.context instanceof Response?await error.context.json().catch(()=>null):null;throw new Error(response?.error||'Amazonの価格を確認できませんでした。再取得してください。');}
 return data;
}
function readPrice(id:string):Promise<ListingPrice>{return new Promise((resolve,reject)=>{
 pending.set(id,[...(pending.get(id)??[]),{resolve,reject}]);
 if(!timer)timer=setTimeout(()=>{timer=undefined;const batch=[...pending.entries()];pending.clear();void(async()=>{for(let start=0;start<batch.length;start+=20){const group=batch.slice(start,start+20);try{const data=await invoke({action:'read',itemIds:group.map(([key])=>key)});for(const[key,listeners]of group){const row=data.rows?.find((r:ListingPrice)=>r.id===key);for(const listener of listeners)row?listener.resolve(row):listener.reject(new Error('価格の取得結果がありません。'));}}catch(e){for(const[,listeners]of group)for(const listener of listeners)listener.reject(e instanceof Error?e:new Error('取得に失敗しました。'));}}})();},40);
 });}
export default function AmazonListingPrice({itemId,sku,salesChannel}:{itemId:string;sku:string;salesChannel:string|null}){
 const [listing,setListing]=useState<ListingPrice|null>(null),[value,setValue]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const root=useRef<HTMLDivElement>(null),lock=useRef(false),readLock=useRef(false),mounted=useRef(true);
 const supported=/^(?:FBA|自己発送|Amazon)(?:[12１２])?$/.test(salesChannel??'');
 useEffect(()=>{mounted.current=true;readLock.current=false;let active=true;setListing(null);setValue('');setError('');setMessage('');if(!supported)return()=>{mounted.current=false;};const el=root.current;if(!el)return;const observer=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;observer.disconnect();void load(()=>active);},{rootMargin:'100px'});observer.observe(el);return()=>{active=false;mounted.current=false;observer.disconnect();};},[itemId,sku,salesChannel]);
 async function load(active=()=>mounted.current){if(lock.current||readLock.current)return;readLock.current=true;setBusy(true);setError('');try{const row=await readPrice(itemId);if(active()){setListing(row);setValue(row.price==null?'':String(row.price));setError(row.error??'');}}catch(e){if(active())setError(e instanceof Error?e.message:'取得に失敗しました。');}finally{if(active()){readLock.current=false;setBusy(false);}}}
 async function save(){
  if(lock.current||!listing?.accountId)return;
  const price=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(price)||price<1){setError('1円以上の整数を入力してください。');return;}
  lock.current=true;setBusy(true);setError('');setMessage('');
  try{const result=await invoke({action:'write',itemId,accountId:listing.accountId,expectedPrice:listing.price,price});if(mounted.current){setMessage(result.verified?'価格を反映しました。':'Amazonが変更を受け付けました。反映を確認中です。');if(result.verified)setListing({...listing,price});else{const row=await readPrice(itemId);setListing(row);if(row.price===price)setMessage('価格を反映しました。');}}}
  catch(e){if(mounted.current)setError(e instanceof Error?e.message:'価格を反映できませんでした。');}
  finally{lock.current=false;if(mounted.current)setBusy(false);}
 }
 if(!supported)return <span>—</span>;
 return <div className="amazon-listing-price" ref={root}><form onSubmit={e=>{e.preventDefault();void save();}}><input aria-label={`${sku}のAmazon出品価格`} type="number" min={1} step={1} value={value} disabled={busy||!listing?.accountId} onChange={e=>setValue(e.target.value)} title={listing?.accountId==='amazon-2'?'Amazon2':'Amazon1'}/><button className="btn primary" type="submit" disabled={busy||!listing?.accountId||value===''}>{busy?'処理中':'反映'}</button></form>{listing?.accountId&&<small>{listing.accountId==='amazon-2'?'Amazon2':'Amazon1'}</small>}{error&&<div className="approved-price-error" role="alert">{error}<button type="button" className="inventory-cell-edit" disabled={busy} onClick={()=>void load()}>再取得</button></div>}{message&&<div role="status" className="approved-price-message">{message}</div>}</div>;
}
