import {useRef,useState} from 'react';
import {getSupabase} from '@bussan/shared';

type ReportPhoto={id:string;drive_file_id:string;sort_order:number};
export default function MalfunctionReportPhotos({itemId}:{itemId:string}){
 const [photos,setPhotos]=useState<ReportPhoto[]|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const reading=useRef(false);
 async function toggle(){
  if(reading.current)return;
  if(photos!==null){setOpen(value=>!value);return;}
  reading.current=true;setBusy(true);setError('');
  try{
   const {data,error:readError}=await getSupabase().rpc('read_malfunction_report_photos',{p_item_id:itemId});
   if(readError)throw readError;
   setPhotos((data??[]) as ReportPhoto[]);setOpen(true);
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{reading.current=false;setBusy(false);}
 }
 return <div className="malfunction-report-photos">
  <button type="button" className="btn" aria-expanded={open} disabled={busy} onClick={()=>void toggle()}>{busy?'写真を確認中…':open?'報告写真を閉じる':'報告写真を確認'}</button>
  {open&&(photos?.length?<div className="malfunction-report-photo-links">{photos.map((photo,index)=><a key={photo.id} href={'https://drive.google.com/file/d/'+encodeURIComponent(photo.drive_file_id)+'/view'} target="_blank" rel="noopener noreferrer">写真{index+1}を開く</a>)}</div>:<p className="muted">報告写真はありません。</p>)}
  {error&&<p className="error" role="alert">{error}</p>}
 </div>;
}
