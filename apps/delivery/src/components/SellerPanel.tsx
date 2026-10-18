import {useEffect,useRef,useState} from 'react';
import {sellerDefaults,SMALL_PACKAGES,canViewDeliveryAssignee} from '@bussan/shared';
import type {DeliveryTask,Staff,SellerDraft} from '@bussan/shared';
import {fetchSellerContext,fetchSellerOperation,fetchTask,fetchPhotoUrls,fetchProductMaker,queueSellerOperation,requestListingResultCheck,performInventoryAction} from '../api';
import type {SellerContext,ItemPhoto,SellerOperation} from '../api';
import {listingDraft} from '../listingDraft';
import DescriptionEditor from './DescriptionEditor';

function PackageCamera({onRead,onClose}:{onRead:(code:string)=>void;onClose:()=>void}){
 const video=useRef<HTMLVideoElement>(null),[error,setError]=useState('');
 useEffect(()=>{let disposed=false,stream:MediaStream|undefined,frame=0,last=0;
  void Promise.all([navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}),import('jsqr')]).then(async([media,{default:decode}])=>{
   stream=media;if(disposed){media.getTracks().forEach(track=>track.stop());return;}const element=video.current;if(!element)return;
   element.srcObject=media;await element.play();const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
   function scan(time:number){if(disposed||!context)return;if(time-last>350&&element!.readyState>=2){last=time;canvas.width=element!.videoWidth;canvas.height=element!.videoHeight;context.drawImage(element!,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height),code=decode(pixels.data,pixels.width,pixels.height);if(code?.data){onRead(code.data);return;}}frame=requestAnimationFrame(scan);}frame=requestAnimationFrame(scan);
  }).catch(cause=>{if(!disposed)setError(cause instanceof Error?cause.message:String(cause));});
  return()=>{disposed=true;cancelAnimationFrame(frame);stream?.getTracks().forEach(track=>track.stop());};
 },[onRead]);
 return <div><video ref={video} className="seller-camera" playsInline muted aria-label="専用資材のコードを読み取るカメラ"/>{error&&<p className="error" role="alert">カメラを起動できません：{error}</p>}<button type="button" className="btn" onClick={onClose}>カメラを閉じる</button></div>;
}
function checking(op:SellerOperation){return op.status==='uncertain'&&['queued','running'].includes(String(op.result.read_check_state));}
function statusText(op:SellerOperation){if(checking(op))return '出品済み商品を確認中';return ({queued:'拡張機能の実行待ち',running:'実行中',succeeded:'完了',failed:'停止',uncertain:'結果の確認が必要'} as const)[op.status];}
export default function SellerPanel({mode,task,staff,listingSkus=[],onClose,onChanged}:{mode:'listing'|'shipping'|'messages';task:DeliveryTask;staff:Staff;listingSkus?:string[];onClose:()=>void;onChanged:(task:DeliveryTask)=>void}){
 const [draft,setDraft]=useState<SellerDraft|null>(null),[photos,setPhotos]=useState<ItemPhoto[]>([]),[selected,setSelected]=useState<string[]>([]),[context,setContext]=useState<SellerContext|null>(null);
 const [descriptionSource,setDescriptionSource]=useState<{task:DeliveryTask;maker:string}|null>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[camera,setCamera]=useState(false),[code,setCode]=useState(''),[posted,setPosted]=useState(false),[qr,setQr]=useState(''),[message,setMessage]=useState('');
 const lock=useRef(false),request=useRef(crypto.randomUUID()),lastFinished=useRef(''),readCode=useRef<(code:string)=>void>(()=>{});
 readCode.current=value=>{setCode(value);setCamera(false);};
 const listingSkuKey=listingSkus.join('\n');
 const onRead=useRef((value:string)=>readCode.current(value)).current;
 useEffect(()=>{let active=true;void Promise.all([fetchTask(task.id,canViewDeliveryAssignee(staff)),fetchSellerContext(task.id),mode==='listing'?fetchPhotoUrls(task.id):Promise.resolve([])]).then(async([full,info,images])=>{if(!active)return;if(!full||!info)throw new Error('商品が見つかりません');const maker=mode==='listing'?await fetchProductMaker(full.asin).catch(()=>''):'';if(!active)return;const prepared={...full,deliverer_name:info.assignee||full.deliverer_name||(full.deliverer_id===staff.id?staff.name:'')};const defaults=mode==='listing'?listingDraft(prepared,maker,listingSkuKey?listingSkuKey.split('\n'):[]):sellerDefaults(prepared);setDraft(mode==='shipping'?{...defaults,...info.shipping_defaults}:defaults);setDescriptionSource({task:prepared,maker});setContext(info);setPhotos(images);setSelected(images.slice(0,10).map(photo=>photo.id));}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});return()=>{active=false;};},[task.id,mode,staff.id,staff.name,staff.role,listingSkuKey]);
 const pending=context?.operations.some(op=>['queued','running','uncertain'].includes(op.status))??false;
 const watching=context?.operations.find(op=>op.status==='queued'||op.status==='running'||checking(op));
 useEffect(()=>{if(!watching)return;let active=true,inFlight=false;
  async function refresh(){if(!active||inFlight||document.visibilityState!=='visible')return;if(Date.now()-Date.parse(checking(watching!)?String(watching!.result.read_check_requested_at):watching!.created_at)>600000){setError('実行結果の確認が必要です。自動再実行はしません。');return;}inFlight=true;
   try{const state=checking(watching!)?{status:'uncertain'}:await fetchSellerOperation(watching!.id);if(!active)return;
    if(checking(watching!)||!['queued','running'].includes(state.status)){const info=await fetchSellerContext(task.id);if(!active)return;setContext(info);const finished=info.operations.find(op=>op.id===watching!.id&&op.status==='succeeded');if(finished&&lastFinished.current!==finished.id){lastFinished.current=finished.id;const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(active&&full)onChanged(full);}}
   }catch(cause){if(active)setError(cause instanceof Error?cause.message:String(cause));}finally{inFlight=false;}
  }
  const timer=window.setInterval(()=>void refresh(),15000);return()=>{active=false;window.clearInterval(timer);};
 },[watching?.id,watching?.result.read_check_state,watching?.result.read_check_requested_at,task.id,staff.role,staff.code,onChanged]);
 useEffect(()=>{setCode('');setPosted(false);setCamera(false);setMessage('');},[context?.listing?.trade_key]);
 const operations=context?.operations??[],latestCode=operations.find(op=>op.kind==='shipping_code'&&op.status==='succeeded'&&op.trade_key===context?.listing?.trade_key),proof=operations.find(op=>op.status==='succeeded'&&op.trade_key===context?.listing?.trade_key&&(op.kind==='register_package'||op.kind==='verify_shipping'&&op.result.accepted===true));
 useEffect(()=>{let active=true;const value=latestCode?.result.qr_code;if(typeof value!=='string'){setQr('');return;}if(value.startsWith('data:image/png;base64,')){setQr(value);return;}void import('qrcode').then(module=>module.toDataURL(value,{width:260,margin:2})).then(url=>{if(active)setQr(url);}).catch(()=>{if(active)setError('配送コードを表示できません');});return()=>{active=false;};},[latestCode?.id]);
 async function submit(kind:string,payload:Record<string,unknown>){if(lock.current||pending)return;lock.current=true;setBusy(true);setError('');try{await queueSellerOperation(task.id,kind,{...payload,expected_revision:context?.revision},request.current);request.current=crypto.randomUUID();setContext(await fetchSellerContext(task.id));setMessage('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(false);}}
 async function checkListing(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await requestListingResultCheck(task.id);setContext(await fetchSellerContext(task.id));}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(false);}}
 function movePhoto(id:string,offset:number){setSelected(current=>{const from=current.indexOf(id),to=from+offset;if(from<0||to<0||to>=current.length)return current;const next=[...current];[next[from],next[to]]=[next[to]!,next[from]!];return next;});request.current=crypto.randomUUID();}
 function change<K extends keyof SellerDraft>(field:K,value:SellerDraft[K]){setDraft(current=>current?{...current,[field]:value}:current);request.current=crypto.randomUUID();}
 const amazonListing=mode==='listing'&&['FBA','自己発送'].includes(task.sales_channel??'');
 async function descriptionSaved(){setContext(await fetchSellerContext(task.id));const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(full)onChanged(full);}
 function updateDescription(value:Partial<SellerDraft>){setDraft(current=>current?{...current,...value}:current);request.current=crypto.randomUUID();}
 async function completeAmazonListing(){if(lock.current||busy||context?.photo_review_approved!==true||task.photo_review_approved!==true)return;lock.current=true;setBusy(true);setError('');try{await performInventoryAction(task,'listing_complete','',request.current);request.current=crypto.randomUUID();const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(full)onChanged(full);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(false);}}
 const disabled=busy||pending||(mode==='listing'&&(task.photo_review_approved!==true||context?.photo_review_approved!==true)),trade=context?.listing?.trade_key;
 const tradePayload={trade_key:trade,size:draft?.size,dropoff:draft?.dropoff,shippingMethod:draft?.shippingMethod,category:draft?.category};
 const latestMessages=operations.find(op=>op.kind==='message_sync'&&op.status==='succeeded'&&op.trade_key===context?.listing?.trade_key)?.result.messages;
 if(mode==='listing'&&task.status!=='商品登録前')return <section className="task-detail-inline seller-panel"><p>現在の状態：{task.status}</p>{context?.listing&&<a href={context.listing.url} target="_blank" rel="noreferrer">出品した商品を確認</a>}</section>;
 return <section className="task-detail-inline seller-panel" aria-label={`${task.sku}の${mode==='listing'?'出品':mode==='shipping'?'発送':'取引メッセージ'}`}>
  {mode!=='listing'&&<button type="button" className="btn ghost" onClick={onClose}>閉じる</button>}
  {error&&<p className="error" role="alert">{error}</p>}
  {mode==='listing'&&context&&context.photo_review_approved!==true&&<p role="status">管理アプリで商品写真の承認が必要です。</p>}
  {!draft?<p>読み込み中…</p>:mode==='listing'?<>
   {descriptionSource&&<DescriptionEditor task={descriptionSource.task} listingSkus={listingSkus} onSaved={descriptionSaved} embedded={{value:draft,manufacturer:descriptionSource.maker,disabled,onSaving:setBusy,onChange:updateDescription}}/>}
   {!amazonListing&&<>
   <div className="seller-form">
    <label className="seller-short">{task.sales_channel==='ヤフオク'?'開始価格':'価格'}<input type="number" min={1} step={1} value={draft.price} disabled={disabled} onChange={event=>change('price',Number(event.target.value))}/></label>
    <label>送料負担<select value={draft.shippingPayer} disabled={disabled} onChange={event=>change('shippingPayer',event.target.value)}>{['出品者負担','購入者負担'].map(value=><option key={value}>{value}</option>)}</select></label>
    <label>配送方法<select value={draft.shippingMethod} disabled={disabled} onChange={event=>change('shippingMethod',event.target.value)}>{(task.sales_channel==='ヤフオク'?['おてがる配送（ヤマト運輸）','おてがる配送（日本郵便）']:['らくらくメルカリ便','ゆうゆうメルカリ便']).map(value=><option key={value}>{value}</option>)}</select></label>
    <label className="seller-short">発送元<input value={draft.origin} disabled={disabled} onChange={event=>change('origin',event.target.value)}/></label>
    <label className="seller-short">発送までの日数<select value={draft.dispatchDays} disabled={disabled} onChange={event=>change('dispatchDays',event.target.value)}>{['1〜2日','2〜3日','4〜7日'].map(value=><option key={value}>{value}</option>)}</select></label>
    {task.sales_channel==='ヤフオク'&&<><label>配送サイズ<select value={draft.size} disabled={disabled} onChange={event=>change('size',event.target.value)}><option value="">選択</option>{(/日本郵便/.test(draft.shippingMethod)?['100','140','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット']:['100','140','宅急便コンパクト']).map(value=><option key={value}>{value}</option>)}</select></label>{/日本郵便/.test(draft.shippingMethod)&&/^\d+$/.test(draft.size)&&draft.shippingPayer==='出品者負担'&&<label>重さ<select value={draft.weightKg??''} disabled={disabled} onChange={event=>change('weightKg',event.target.value)}><option value="">選択</option>{['2','5','10','15','20','25'].map(value=><option key={value} value={value}>{value}kg以内</option>)}</select></label>}</>}
    <label>出品カテゴリ<input value={draft.listingCategory??''} disabled={disabled} maxLength={200} placeholder="サイトのカテゴリ名" onChange={event=>change('listingCategory',event.target.value)}/></label>
    {task.sales_channel==='ヤフオク'&&<><label className="seller-short">終了までの日数<input type="number" min={1} max={7} value={draft.auctionDays} disabled={disabled} onChange={event=>change('auctionDays',Number(event.target.value))}/></label><label className="seller-short">終了時間帯<select value={draft.closingHour} disabled={disabled} onChange={event=>change('closingHour',Number(event.target.value))}>{Array.from({length:24},(_,hour)=><option key={hour} value={hour}>{hour}時台</option>)}</select></label><label><input type="checkbox" checked={draft.autoExtend} disabled={disabled} onChange={event=>change('autoExtend',event.target.checked)}/>自動延長</label><label><input type="checkbox" checked={draft.autoRelist} disabled={disabled} onChange={event=>change('autoRelist',event.target.checked)}/>自動再出品</label></>}
   </div>
   <div className="seller-photos" aria-label="出品写真の掲載順">{[...selected.flatMap(id=>{const photo=photos.find(value=>value.id===id);return photo?[photo]:[];}),...photos.filter(photo=>!selected.includes(photo.id))].map(photo=>{const order=selected.indexOf(photo.id);return <div key={photo.id} className="seller-photo" role="group" aria-label={order<0?'出品しない写真':`写真${order+1}`}>
    <label><span>{order<0?'出品しない':`${order+1}枚目`}</span><img src={photo.url} alt="出品写真" loading="lazy"/><input type="checkbox" aria-label={order<0?'この写真を出品に含める':`${order+1}枚目を出品に含める`} checked={order>=0} disabled={disabled||order<0&&selected.length>=10} onChange={event=>{setSelected(current=>event.target.checked?[...current,photo.id]:current.filter(id=>id!==photo.id));request.current=crypto.randomUUID();}}/></label>
    {order>=0&&<div className="seller-photo-order"><button type="button" className="btn" aria-label={`写真${order+1}を前へ`} title="前へ" disabled={disabled||order===0} onClick={()=>movePhoto(photo.id,-1)}>←</button><button type="button" className="btn" aria-label={`写真${order+1}を後へ`} title="後へ" disabled={disabled||order===selected.length-1} onClick={()=>movePhoto(photo.id,1)}>→</button></div>}
   </div>;})}</div>
   <button type="button" className="btn primary" disabled={disabled||!draft.title.trim()||!draft.description.trim()||!draft.listingCategory?.trim()||draft.price<1||task.sales_channel==='ヤフオク'&&(!(/日本郵便/.test(draft.shippingMethod)?['100','140','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット']:['100','140','宅急便コンパクト']).includes(draft.size)||/日本郵便/.test(draft.shippingMethod)&&/^\d+$/.test(draft.size)&&draft.shippingPayer==='出品者負担'&&!draft.weightKg)||!draft.origin||!draft.condition||selected.length<1||selected.length>10} onClick={()=>{if(window.confirm(`${task.sales_channel}へこの内容で出品しますか？`))void submit('listing',{...draft,photos:selected.flatMap(id=>{const photo=photos.find(value=>value.id===id);return photo?[photo.url]:[];})});}}>出品</button>
   </>}
   {amazonListing&&<button type="button" className="btn primary" disabled={disabled} onClick={()=>void completeAmazonListing()}>出品完了</button>}
  </>:!trade?<p>販売先の取引情報の取得待ちです。</p>:mode==='shipping'?<>
   <div className="seller-form"><label>配送サイズ<select value={draft.size} disabled={disabled} onChange={event=>change('size',event.target.value)}><option value="">選択</option>{['100','140',...SMALL_PACKAGES.map(value=>value.name)].map(value=><option key={value}>{value}</option>)}</select></label><label>発送場所<select value={draft.dropoff} disabled={disabled} onChange={event=>change('dropoff',event.target.value)}><option value="">選択</option>{['ヤマト営業所','セブンイレブン','ローソン'].map(value=><option key={value}>{value}</option>)}</select></label></div>
   {draft.category==='小物'&&<div>{SMALL_PACKAGES.map(value=><p key={value.name}>{value.name}：{value.dimensions}</p>)}</div>}
   {/ゆうパケットポストmini/.test(draft.size)?<>
    <button type="button" className="btn" disabled={disabled} onClick={()=>setCamera(true)}>専用資材のコードを読む</button>{camera&&<PackageCamera onRead={onRead} onClose={()=>setCamera(false)}/>}
    {code&&<><p>専用資材のコードを読み取りました。</p><button type="button" className="btn" disabled={disabled} onClick={()=>void submit('register_package',{...tradePayload,code})}>対象取引へ登録</button></>}
    {proof?.kind==='register_package'&&<label><input type="checkbox" checked={posted} onChange={event=>setPosted(event.target.checked)}/>投函しました</label>}
   </>:<><button type="button" className="btn" disabled={disabled||!draft.size||!draft.dropoff} onClick={()=>void submit('shipping_code',tradePayload)}>配送QRコードを表示</button>{qr&&<img src={qr} className="seller-qr" alt="対象取引の配送QRコード"/>}<button type="button" className="btn" disabled={disabled||!latestCode} onClick={()=>void submit('verify_shipping',tradePayload)}>店舗での受付を確認</button></>}
   <button type="button" className="btn primary" disabled={disabled||!proof||proof.kind==='register_package'&&!posted} onClick={()=>void submit('ship_notice',{...tradePayload,proof_id:proof?.id,posted})}>発送通知</button>
  </>:<>
   <button type="button" className="btn" disabled={disabled} onClick={()=>void submit('message_sync',tradePayload)}>メッセージを取得</button>
   {Array.isArray(latestMessages)&&latestMessages.map((entry,index)=><p key={index} className="seller-preview">{entry&&typeof entry==='object'&&typeof entry.body==='string'?entry.body:''}</p>)}
   <textarea aria-label="取引相手へのメッセージ" value={message} maxLength={2000} disabled={disabled} onChange={event=>{setMessage(event.target.value);request.current=crypto.randomUUID();}}/>
   <button type="button" className="btn primary" disabled={disabled||!message.trim()} onClick={()=>{if(window.confirm('取引相手へ送信しますか？'))void submit('message_send',{...tradePayload,body:message.trim()});}}>送信</button>
  </>}
  {mode==='listing'&&operations.some(op=>op.kind==='listing'&&op.status==='uncertain')&&<button type="button" className="btn" disabled={busy||!!watching} onClick={()=>void checkListing()}>出品結果を確認</button>}
  <div className="seller-history" aria-live="polite">{operations.map(op=><p key={op.id}>{statusText(op)}{typeof op.result.last_check_note==='string'?'：'+op.result.last_check_note:typeof op.result.note==='string'?'：'+op.result.note:''}{op.status==='running'&&Date.now()-Date.parse(op.created_at)>600000?'。結果を確認するまで再実行しません。':''}</p>)}</div>
 </section>;
}
