import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {getSupabase,noticeProductUrl,readResourceSnapshot} from '@bussan/shared';
import {deliveryAppUrl} from '../appUrls';
import {adminTaskNotice} from '../taskNotice';
type Task={id:string;item_id:string;sku:string;lot_seq:number;marketplace:string|null;marketplace_item_id:string|null;marketplace_url:string|null;submitted_at:string;photo_count:number};
type Photo={id:string;url:string};
export default function PackingPhotoTasks(){
 const [rows,setRows]=useState<Task[]>([]),[selected,setSelected]=useState<Task|null>(null);
 const [photos,setPhotos]=useState<Photo[]>([]),[loaded,setLoaded]=useState<Set<string>>(new Set());
 const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const closing=useRef(false),noticeHandled=useRef(false);
 useEffect(()=>{
  let active=true,reading=false,lastRead=0;
  async function refresh(){
   if(reading)return;reading=true;lastRead=Date.now();
   try{
    const tasks=await readResourceSnapshot<Task>('packing_photos');
    if(active){
     setRows(tasks);setError('');
     const notice=adminTaskNotice();
     if(!noticeHandled.current&&notice?.kind==='packing_photo'){
      noticeHandled.current=true;const task=tasks.find(row=>row.item_id===notice.itemId);
      if(task)setSelected(task);else setError('通知の梱包写真はすでに確認済みか、現在は確認できません。');
     }
    }
   }catch(cause){if(active)setError((cause as {message?:string})?.message||'梱包写真の案内を読み込めませんでした。');}
   finally{reading=false;}
  }
  const visible=()=>{if(document.visibilityState==='visible'&&Date.now()-lastRead>=60000)void refresh();};
  void refresh();window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
 },[]);
 useEffect(()=>{
  setPhotos([]);setLoaded(new Set());setError('');
  if(!selected)return;
  let active=true;setLoading(true);
  void(async()=>{
   const {data,error:readError}=await getSupabase().functions.invoke('delivery-photo-drive',{body:{itemId:selected.item_id,action:'list',purpose:'packing'}});
   if(readError)throw readError;
   if(!Array.isArray(data?.photos)||data.photos.length!==selected.photo_count)throw Error('梱包写真が更新されています。一度閉じて、確認画面を開き直してください。');
   if(active)setPhotos(data.photos as Photo[]);
  })().catch(cause=>{if(active)setError((cause as {message?:string})?.message||'梱包写真を読み込めませんでした。');})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[selected]);
 async function close(){
  if(closing.current)return;
  if(!selected||loading||error||loaded.size!==photos.length||photos.length===0){setSelected(null);return;}
  closing.current=true;setBusy(true);
  try{
   const {error:ackError}=await getSupabase().rpc('acknowledge_packing_photos',{p_item_id:selected.item_id,p_submitted_at:selected.submitted_at});
   if(ackError)throw ackError;
   setRows(current=>current.filter(row=>row.item_id!==selected.item_id));setSelected(null);
  }catch(cause){setError((cause as {message?:string})?.message||'確認状態を保存できませんでした。');}
  finally{closing.current=false;setBusy(false);}
 }
 return <>{rows.map(row=>{
  const source=noticeProductUrl(row.marketplace,row.marketplace_item_id,row.marketplace_url);
  return <li key={row.id} className="admin-task-card admin-simple-task">
   <div className="task-action-details"><strong>梱包が追加されました。</strong>
    <a href={deliveryAppUrl+'?itemId='+encodeURIComponent(row.item_id)}>【{row.sku.match(/^([^-]+)-/)?.[1]||row.lot_seq}】</a>
    {source?<a href={source} target="_blank" rel="noopener noreferrer">【{row.marketplace_item_id}】</a>:<span>【{row.marketplace_item_id||'商品ID未登録'}】</span>}<small>{row.sku}</small>
   </div><button type="button" className="btn" onClick={()=>setSelected(row)}>確認</button>
  </li>;
 })}{error&&!selected&&<li className="error" role="alert">{error}</li>}
 {selected&&createPortal(<div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="梱包写真の確認">
  <div className="card inventory-comment-panel photo-review-panel">
   <div className="toolbar"><h3>{selected.sku} の梱包写真</h3><span style={{flex:1}}/><button type="button" className="btn" disabled={busy} onClick={()=>void close()}>閉じる</button></div>
   <p>写真を確認して閉じると、このやることは一覧から消えます。</p>
   {loading?<p>写真を読み込み中…</p>:<div className="photo-review-gallery">{photos.map(photo=><a key={photo.id} href={photo.url} target="_blank" rel="noopener noreferrer"><img src={photo.url} alt="登録した梱包写真"
    onLoad={()=>setLoaded(current=>new Set([...current,photo.id]))} onError={()=>setError('梱包写真を表示できませんでした。再度確認してください。')}/></a>)}</div>}
   {error&&<p className="error" role="alert">{error}</p>}
  </div>
 </div>,document.body)}</>;
}
