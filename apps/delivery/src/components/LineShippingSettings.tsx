import {useEffect,useRef,useState} from 'react';
import {getSupabase,sellerShippingError,sellerShippingPlaces} from '@bussan/shared';
import type {SellerDraft} from '@bussan/shared';
import {fetchPhotoUrls} from '../api';
import type {ItemPhoto} from '../api';
import {linePhotoOrder} from '../linePhotoOrder';
type Context={overviewPhotoId:string|null;modelPhotoId:string|null;photoOrder?:string[];shipping:Record<string,string>;state:string|null;message:string;enabled:boolean};
export default function LineShippingSettings({itemId,draft,overviewId,listing=false}:{itemId:string;draft:SellerDraft;overviewId?:string;listing?:boolean}){
 const [context,setContext]=useState<Context|null>(null),[photos,setPhotos]=useState<ItemPhoto[]|null>(null),[overview,setOverview]=useState(''),[model,setModel]=useState(''),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const active=useRef(true),lock=useRef(false);
 useEffect(()=>{let live=true;active.current=true;void getSupabase().rpc('line_shipping_context',{p_item_id:itemId}).then(({data,error})=>{if(!live)return;if(error){setError('LINE発送設定を確認できません');return;}const value=data as Context;setContext(value);setOverview(value.overviewPhotoId||'');setModel(value.modelPhotoId||'');});return()=>{live=false;active.current=false;};},[itemId]);
 async function edit(){if(lock.current||!context)return;lock.current=true;setBusy(true);setError('');try{const values=linePhotoOrder(await fetchPhotoUrls(itemId),context.photoOrder);if(active.current){setPhotos(values);setOverview(current=>current||overviewId||values[0]?.id||'');setOpen(true);}}catch{if(active.current)setError('商品写真を取得できませんでした');}finally{lock.current=false;if(active.current)setBusy(false);}}
 async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{
  if(draft.size){const issue=sellerShippingError(draft);if(issue)throw new Error(issue);}
  else if(draft.dropoff&&!sellerShippingPlaces(draft.shippingMethod).includes(draft.dropoff))throw new Error('配送方法に対応する発送場所を選択してください');
  const shipping={size:draft.size,dropoff:draft.dropoff,shippingMethod:draft.shippingMethod,category:draft.category,...(draft.weightKg?{weightKg:draft.weightKg}:{})};
  const {error}=await getSupabase().rpc('save_line_shipping_preferences',{p_item_id:itemId,p_overview:overview||null,p_model:model||null,p_shipping:shipping});if(error)throw error;
  const result=await getSupabase().rpc('line_shipping_context',{p_item_id:itemId});if(result.error)throw result.error;
  if(active.current){setContext(result.data as Context);setOpen(false);}
 }catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'LINE発送設定を保存できませんでした');}finally{lock.current=false;if(active.current)setBusy(false);}}
 return <section className="line-shipping-settings" aria-label="LINE発送依頼の設定">
  <div className="row"><span>LINE発送依頼</span><button type="button" className="btn ghost" disabled={busy||!context} onClick={()=>void edit()}>通知写真を設定</button>{!listing&&<button type="button" className="btn ghost" disabled={busy} onClick={()=>void save()}>配送設定を保存</button>}</div>
  {context?.state==='sent'&&<p role="status">LINEへ送信済み</p>}{error&&<p className="error" role="alert">{error}</p>}
  {open&&photos&&<>
   <p>全体写真と、型番が読める写真を一度指定してください。梱包写真は通知に使いません。</p>
   <p>{context?.photoOrder?.length?'出品時の写真順です。出品に使わなかった写真は末尾に表示します。':'写真の追加順です。'}</p>
   <div className="seller-photos" aria-label="LINE通知に使う商品写真">{photos.map((photo,index)=><div key={photo.id} className="seller-photo">
    <span>{index+1}枚目</span><img src={photo.url} alt={`商品写真${index+1}`} loading="lazy"/>
    <label><input type="radio" name={`line-overview-${itemId}`} value={photo.id} checked={overview===photo.id} onChange={()=>setOverview(photo.id)}/>全体写真</label>
    <label><input type="radio" name={`line-model-${itemId}`} value={photo.id} checked={model===photo.id} onChange={()=>setModel(photo.id)}/>型番確認</label>
   </div>)}</div>
   <button type="button" className="btn primary" disabled={busy||!overview||!model} onClick={()=>void save()}>通知写真を保存</button>
   <button type="button" className="btn ghost" disabled={busy} onClick={()=>setOpen(false)}>閉じる</button>
  </>}
 </section>;
}
