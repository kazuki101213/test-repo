import {useEffect,useRef,useState} from 'react';
import {applyYahooListingShipping,yahooListingSizes,sellerDefaults,sellerListingCategoryError,sellerShippingDraft,sellerShippingPlaces,sellerShippingSizes,sellerShippingError,sellerShippingCodeError,mercariShippingSize,SMALL_PACKAGES,canViewDeliveryAssignee,isAmazonSalesChannel,marketplaceAccountLabel} from '@bussan/shared';
import type {DeliveryTask,Staff,SellerDraft} from '@bussan/shared';
import {fetchSellerContext,fetchSellerOperation,fetchTask,fetchPhotoUrls,fetchProductMaker,queueSellerOperation,retryUncertainShippingCode,requestListingResultCheck,submitAmazonListing,fetchAmazonListingPending,fetchListingPhotoAnalysis,mercariShippingHandoff} from '../api';
import type {SellerContext,ItemPhoto,SellerOperation,MercariShippingHandoffState} from '../api';
import {listingDraft} from '../listingDraft';
import {accessoryOptions} from '../description';
import {listingPhotoOrder} from '../listingPhotoOrder';
import {deliveryErrorMessage} from '../errors';
import DescriptionEditor from './DescriptionEditor';
import OperationProgress,{SellerOperationProgress,operationLabel,formatOperationTime,type OperationPhase,type PendingSellerOperation} from './OperationProgress';
import WorkDateConfirmation from './WorkDateConfirmation';
import LineShippingSettings from './LineShippingSettings';

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
function statusText(op:SellerOperation){
 if(checking(op))return '出品済み商品を確認中';
 if(op.status==='succeeded'&&op.kind==='shipping_code')return '発送コード取得済み';
 return ({queued:'拡張機能の実行待ち',running:'実行中',succeeded:'完了',failed:'停止',uncertain:'結果の確認が必要'} as const)[op.status];
}

function MarketplaceShippingHandoff({itemId,tradeKey,disabled}:{itemId:string;tradeKey:string;disabled:boolean}){
 const [state,setState]=useState<MercariShippingHandoffState|null>(null);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  void mercariShippingHandoff(itemId,tradeKey).then(value=>{
   if(active)setState(value);
  }).catch(cause=>{
   if(active)setError(deliveryErrorMessage(cause));
  });
  return()=>{active=false;};
 },[itemId,tradeKey]);

 async function confirmHandoff(){
  if(saving||disabled||!window.confirm('この商品の荷物を店員や配送業者に渡した、またはポストに投函しましたか？'))return;
  setSaving(true);
  setError('');
  try{setState(await mercariShippingHandoff(itemId,tradeKey,true));}
  catch(cause){setError(deliveryErrorMessage(cause));}
  finally{setSaving(false);}
 }

 return <>
  {state==='pending'&&<button type="button" className="btn" data-direction="forward" disabled={disabled||saving} onClick={()=>void confirmHandoff()}>
   発送完了
  </button>}
  {state==='confirmed'&&<p role="status">荷物の引き渡しを記録しました。発送通知は定期処理で行います。</p>}
  {state==='notified'&&<p role="status">発送通知済み</p>}
  {error&&<p className="error" role="alert">{error}</p>}
 </>;
}

export default function SellerPanel({mode,task,staff,listingSkus=[],onClose,onChanged}:{mode:'listing'|'shipping'|'messages';task:DeliveryTask;staff:Staff;listingSkus?:string[];onClose:()=>void;onChanged:(task:DeliveryTask,keepVisible?:boolean)=>void}){
 const [draft,setDraft]=useState<SellerDraft|null>(null),[photos,setPhotos]=useState<ItemPhoto[]>([]),[selected,setSelected]=useState<string[]>([]),[context,setContext]=useState<SellerContext|null>(null);
 const [descriptionSource,setDescriptionSource]=useState<{task:DeliveryTask;maker:string}|null>(null);
 const [photoAnalysis,setPhotoAnalysis]=useState<{message:string;accessories:string[];overview?:string;reading?:boolean}>({message:'',accessories:[]});
 const photosEdited=useRef(false);
 const receiptPhotos=useRef(false);
 // Read the parent callback through a ref so a new identity does not restart the operation watcher.
 const onChangedRef=useRef(onChanged);onChangedRef.current=onChanged;
 const [listingUrl,setListingUrl]=useState('');
 const [confirming,setConfirming]=useState<'listing'|'listing_complete'|null>(null);
 const [amazonConfirmation,setAmazonConfirmation]=useState<{sku:string;price:number;persistYear:()=>Promise<void>}|null>(null);
 const [amazonAwaiting,setAmazonAwaiting]=useState<{date:string;requestId:string;photoIds:string[];expected:{sku:string;price:number}}|null>(null),[amazonNotice,setAmazonNotice]=useState('');
 const [amazonPhase,setAmazonPhase]=useState<OperationPhase|null>(null),[amazonVerifiedAt,setAmazonVerifiedAt]=useState<string|null>(null);
 const [operationLocal,setOperationLocal]=useState<PendingSellerOperation|null>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[camera,setCamera]=useState(false),[code,setCode]=useState(''),[qr,setQr]=useState(''),[message,setMessage]=useState('');
 const lock=useRef(false),request=useRef(crypto.randomUUID()),lastFinished=useRef(''),readCode=useRef<(code:string)=>void>(()=>{});
 readCode.current=value=>{setCode(value);setCamera(false);};
 const listingSkuKey=listingSkus.join('\n');
 const onRead=useRef((value:string)=>readCode.current(value)).current;
 useEffect(()=>{
  let active=true;
  photosEdited.current=false;
  receiptPhotos.current=false;
  setPhotoAnalysis({message:'',accessories:[]});
  setAmazonAwaiting(null);setAmazonNotice('');setAmazonPhase(null);setAmazonVerifiedAt(null);setOperationLocal(null);
  void Promise.all([
   fetchTask(task.id,canViewDeliveryAssignee(staff)),fetchSellerContext(task.id),
   mode==='listing'?fetchPhotoUrls(task.id):Promise.resolve([]),
   mode==='listing'&&isAmazonSalesChannel(task.sales_channel)?fetchAmazonListingPending(task.id):Promise.resolve(null),
  ]).then(async([full,info,images,receipt])=>{
   if(!active)return;
   if(!full||!info)throw new Error('商品が見つかりません');
   const maker=mode==='listing'?await fetchProductMaker(full.asin).catch(()=>''):'';
   if(!active)return;
   const prepared={...full,deliverer_name:info.assignee||full.deliverer_name||(full.deliverer_id===staff.id?staff.name:'')};
   const defaults=mode==='listing'?listingDraft(prepared,maker,listingSkuKey?listingSkuKey.split('\n'):[]):sellerDefaults(prepared);
   receiptPhotos.current=!!receipt;
   const selection=receipt?.photoIds.length?receipt.photoIds:images.slice(0,isAmazonSalesChannel(full.sales_channel)?6:10).map(photo=>photo.id);
   let initial=defaults;
   if(mode==='shipping')initial=sellerShippingDraft(defaults,info.shipping_defaults);
   if(mode==='listing'&&full.sales_channel==='メルカリ')initial={...defaults,size:mercariShippingSize(defaults.shippingMethod,defaults.size)};
   if(mode==='listing'&&full.sales_channel==='ヤフオク'){
    const rule=info.yahoo_listing_shipping;
    initial=rule?applyYahooListingShipping(defaults,rule):{...defaults,shippingMethod:'',size:'',weightKg:undefined,origin:'',dropoff:''};
   }
   setDraft(initial);
   setDescriptionSource({task:prepared,maker});setContext(info);setPhotos(images);setSelected(selection);
   const currentReceipt=receipt&&receipt.asin===full.asin&&receipt.price===full.planned_price&&receipt.condition===full.condition&&receipt.salesChannel===full.sales_channel&&receipt.description===(full.description??'');
   if(currentReceipt&&receipt.state==='verified'&&(/^FBA/.test(full.sales_channel??'')||full.status!=='商品登録前')){
    setAmazonPhase('complete');setAmazonVerifiedAt(receipt.verifiedAt);
    setAmazonNotice(/^FBA/.test(full.sales_channel??'')?'商品情報・写真の登録を確認しました。FBA納品手続きは別途必要です。':'商品情報・写真の登録を確認しました。');
   }else if(currentReceipt&&full.planned_price){
    setAmazonAwaiting({date:receipt.date,requestId:receipt.requestId,photoIds:selection,expected:{sku:full.sku,price:full.planned_price}});
    setAmazonPhase('waiting');setAmazonNotice('商品情報・写真の登録結果を自動確認しています。');
   }
  }).catch(cause=>{if(active)setError(deliveryErrorMessage(cause));});
  return()=>{active=false;};
 },[task.id,mode,staff.id,staff.name,staff.role,listingSkuKey,task.sales_channel]);
 const pending=context?.operations.some(op=>['queued','running','uncertain'].includes(op.status))??false;
 const photoKey=photos.map(photo=>photo.id).join(',');
 const category=draft?.category??'';
 const photoChannel=isAmazonSalesChannel(task.sales_channel)?'amazon':task.sales_channel==='メルカリ'?'mercari':task.sales_channel==='ヤフオク'?'yahoo':null;
 useEffect(()=>{
  if(mode!=='listing'||descriptionSource?.task.id!==task.id||task.status!=='商品登録前'||!photoChannel||!photoKey||receiptPhotos.current||pending) return;
  let active=true;
  const ids=photoKey.split(',');
  setPhotoAnalysis({message:'写真の並び順と付属品を確認中…',accessories:[],reading:true});
  void Promise.resolve().then(()=>fetchListingPhotoAnalysis(task.id,photoKey,accessoryOptions(category))).then(analysis=>{
   if(!active)return;
   if(!photosEdited.current&&!lock.current)setSelected(listingPhotoOrder(ids,analysis,photoChannel,category==='ブルーレイレコーダー'));
   setPhotoAnalysis({
    message:analysis.roles.overview?'1枚目と付属品を確認してください。':'全体写真を確認できませんでした。1枚目を選んでください。',
    overview:analysis.roles.overview,
    accessories:analysis.accessories,
   });
  }).catch(()=>{
   if(active)setPhotoAnalysis({message:'写真を自動判定できませんでした。並び順と付属品を確認してください。',accessories:[]});
  });
  return()=>{active=false;};
 },[task.id,task.status,descriptionSource?.task.id,mode,category,photoChannel,photoKey,pending]);
 const watching=context?.operations.find(op=>op.status==='queued'||op.status==='running'||checking(op));
 useEffect(()=>{if(!watching)return;let active=true,inFlight=false;
  async function refresh(){if(!active||inFlight||document.visibilityState!=='visible')return;if(Date.now()-Date.parse(checking(watching!)?String(watching!.result.read_check_requested_at):watching!.created_at)>600000){setError('実行結果の確認が必要です。自動再実行はしません。');return;}inFlight=true;
   try{const state=checking(watching!)?{status:'uncertain'}:await fetchSellerOperation(watching!.id);if(!active)return;
    if(checking(watching!)||!['queued','running'].includes(state.status)){const info=await fetchSellerContext(task.id);if(!active)return;const finished=info.operations.find(op=>op.id===watching!.id&&op.status==='succeeded');if(finished&&lastFinished.current!==finished.id){const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(!active)return;if(full){lastFinished.current=finished.id;onChangedRef.current(full,finished.kind==='listing');}}setContext(info);}
   }catch(cause){if(active)setError(deliveryErrorMessage(cause));}finally{inFlight=false;}
  }
  const timer=window.setInterval(()=>void refresh(),15000);return()=>{active=false;window.clearInterval(timer);};
 },[watching?.id,watching?.result.read_check_state,watching?.result.read_check_requested_at,task.id,staff.role,staff.code]);
 useEffect(()=>{setCode('');setCamera(false);setMessage('');},[context?.listing?.trade_key]);
 const operations=context?.operations??[],latestShipping=operations.find(op=>op.kind==='shipping_code'&&op.trade_key===context?.listing?.trade_key),latestCode=latestShipping?.status==='succeeded'?latestShipping:undefined;
 useEffect(()=>{let active=true;const value=latestCode?.result.qr_code;if(typeof value!=='string'){setQr('');return;}if(value.startsWith('data:image/png;base64,')){setQr(value);return;}void import('qrcode').then(module=>module.toDataURL(value,{width:260,margin:2})).then(url=>{if(active)setQr(url);}).catch(()=>{if(active)setError('配送コードを表示できません');});return()=>{active=false;};},[latestCode?.id]);
 async function submit(kind:string,payload:Record<string,unknown>){if(lock.current||pending)return;lock.current=true;setBusy(true);setError('');setOperationLocal({kind:kind,state:'sending'});try{await queueSellerOperation(task.id,kind,{...payload,expected_revision:context?.revision},request.current);request.current=crypto.randomUUID();setContext(await fetchSellerContext(task.id));setMessage('');setOperationLocal(null);}catch(cause){setOperationLocal({kind:kind,state:'uncertain'});setError(deliveryErrorMessage(cause));}finally{lock.current=false;setBusy(false);}}
 async function retryShipping(payload:Record<string,unknown>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setOperationLocal({kind:'shipping_code',state:'sending'});try{await retryUncertainShippingCode(task.id,{...payload,expected_revision:context?.revision},request.current);request.current=crypto.randomUUID();setContext(await fetchSellerContext(task.id));setMessage('');setOperationLocal(null);}catch(cause){setOperationLocal({kind:'shipping_code',state:'uncertain'});setError(deliveryErrorMessage(cause));}finally{lock.current=false;setBusy(false);}}
 async function checkListing(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setOperationLocal({kind:'listing',state:'sending'});try{await requestListingResultCheck(task.id,listingUrl);setContext(await fetchSellerContext(task.id));setOperationLocal(null);}catch(cause){setOperationLocal({kind:'listing',state:'uncertain'});setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(false);}}
 function movePhoto(id:string,offset:number){photosEdited.current=true;setSelected(current=>{const from=current.indexOf(id),to=from+offset;if(from<0||to<0||to>=current.length)return current;const next=[...current];[next[from],next[to]]=[next[to]!,next[from]!];return next;});request.current=crypto.randomUUID();}
 function change<K extends keyof SellerDraft>(field:K,value:SellerDraft[K]){setDraft(current=>current?{...current,[field]:value}:current);request.current=crypto.randomUUID();}
 function changeMercariMethod(method:string){
  setDraft(current=>{
   if(!current)return current;
   const equivalent:Record<string,string>={'ゆうパック60〜100':'100','ゆうパック120〜170':'140','宅急便60〜160':'100','宅急便180〜200':'140'};
   const size=mercariShippingSize(method,equivalent[current.size]??current.size);
   return {...current,shippingMethod:method,size:sellerShippingSizes(method).includes(size)?size:''};
  });
  request.current=crypto.randomUUID();
 }
 const amazonListing=mode==='listing'&&isAmazonSalesChannel(task.sales_channel);
 const categoryError=draft?sellerListingCategoryError(draft,task.sales_channel):'';
 async function descriptionSaved(){setContext(await fetchSellerContext(task.id));const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(full)onChanged(full);}
 const yahooListing=mode==='listing'&&task.sales_channel==='ヤフオク';
 const yahooRule=context?.yahoo_listing_shipping;
 const yahooSizeLocked=yahooRule?.source==='sale'||draft?.category!=='小物';
 const yahooNeedsWeight=/^\d+$/.test(draft?.size??'');
 const yahooWeights=['2','5','10','15','20','25',...(['180','200'].includes(draft?.size??'')?['30']:[])];
 const yahooShippingError=!yahooListing?'':!yahooRule?.shippingMethod?'担当者のヤフオク配送設定を確認してください。':
  !draft||!yahooListingSizes(draft.shippingMethod).includes(draft.size)||yahooNeedsWeight&&!yahooWeights.includes(draft.weightKg??'')?'梱包後の配送サイズと重さを確認してください。':'';
 function updateDescription(value:Partial<SellerDraft>){
  setDraft(current=>{
   if(!current)return current;
   const next={...current,...value};
   if(!yahooListing||!yahooRule||next.category===current.category)return next;
   return applyYahooListingShipping(next,yahooRule);
  });
  request.current=crypto.randomUUID();
 }
 async function beginAmazonListing(persistYear:()=>Promise<void>){if(lock.current||busy||amazonAwaiting||amazonPhase==='complete')return;lock.current=true;setBusy(true);setError('');setAmazonPhase('checking');setAmazonNotice('ASIN・コンディション・販売価格を確認しています。');setAmazonVerifiedAt(null);try{const full=await fetchTask(task.id,canViewDeliveryAssignee(staff));if(!full)throw new Error('商品が見つかりません。');if(!full.asin||!/^[A-Z0-9]{10}$/.test(full.asin))throw new Error('ASINを登録してください。');if(!['ほぼ新品','非常に良い','良い','可'].includes(full.condition??''))throw new Error('コンディションを登録してください。');if(!Number.isSafeInteger(full.planned_price)||(full.planned_price??0)<1)throw new Error('予定販売価格が未登録です。管理アプリで販売予定金額を入力してください。');setAmazonConfirmation({sku:full.sku,price:full.planned_price!,persistYear});setAmazonPhase('confirmation');setAmazonNotice('確認画面で実行するとAmazonへ送信します。');setConfirming('listing_complete');}catch(cause){setAmazonPhase('failed');setAmazonNotice('');setError(cause instanceof Error?cause.message:String(cause));}finally{lock.current=false;setBusy(false);}}
 async function completeAmazonListing(date:string){
  if(lock.current||busy||!amazonConfirmation||context?.photo_review_approved!==true||task.photo_review_approved!==true)return;
  lock.current=true;setBusy(true);setError('');setAmazonPhase('submitting');setAmazonNotice('商品情報・写真をAmazonへ送信しています。');
  try{
   const {sku,price,persistYear}=amazonConfirmation;await persistYear();const expected={sku,price};
   const result=await submitAmazonListing(task.id,date,request.current,selected,expected);
   if(!result.verified){
    setAmazonPhase('waiting');setAmazonNotice(result.note);
    if(result.state==='retryable'){setAmazonAwaiting(null);return;}
    if(result.state==='failed')throw new Error(result.note);
    if(result.offerVerified&&result.state!=='retryable'){showOfferListed();return;}
    setAmazonAwaiting({date:result.workCompletedOn??date,requestId:result.requestId??request.current,photoIds:[...selected],expected});return;
   }
   const receipt=result.verifiedAt?null:await fetchAmazonListingPending(task.id).catch(()=>null);
   request.current=crypto.randomUUID();setAmazonPhase('complete');setAmazonVerifiedAt(result.verifiedAt??receipt?.verifiedAt??null);setAmazonNotice(result.note);
   const full=await fetchTask(task.id,canViewDeliveryAssignee(staff)).catch(()=>null);if(full)onChanged(full,true);
  }catch(cause){request.current=crypto.randomUUID();setAmazonPhase('failed');setAmazonNotice('');setError(cause instanceof Error?cause.message:String(cause));throw cause;}
  finally{lock.current=false;setBusy(false);}
 }
 const changedCallback=useRef(onChanged);changedCallback.current=onChanged;
 // Amazonで出品（ASIN・価格・コンディション・配送）を確認できたら完了として出す。写真の取り込みはAmazon側で数時間かかることがある（2026-11-27）。
 function showOfferListed(){request.current=crypto.randomUUID();setAmazonPhase('complete');setAmazonVerifiedAt(null);setAmazonNotice(/^FBA/.test(task.sales_channel??'')?'Amazonへの出品を確認しました。商品写真はAmazon側で取り込み中です（数時間かかることがあります）。FBA納品手続きは別途必要です。':'Amazonへの出品を確認しました。商品写真はAmazon側で取り込み中です（数時間かかることがあります）。');}
 useEffect(()=>{if(!amazonAwaiting)return;let active=true,inFlight=false;
  async function refreshAmazon(){
   if(!active||inFlight||document.visibilityState!=='visible')return;inFlight=true;
   try{
    const result=await submitAmazonListing(task.id,amazonAwaiting!.date,amazonAwaiting!.requestId,amazonAwaiting!.photoIds,amazonAwaiting!.expected,true);if(!active)return;
    if(result.state==='retryable'){setAmazonAwaiting(null);setAmazonPhase('waiting');setAmazonNotice(result.note);return;}
    if(result.offerVerified){setAmazonAwaiting(null);showOfferListed();const full=await fetchTask(task.id,canViewDeliveryAssignee(staff)).catch(()=>null);if(active&&full)changedCallback.current(full,true);return;}
    if(result.state==='failed'){setAmazonAwaiting(null);setAmazonPhase('failed');setAmazonNotice('');setError(result.note);return;}
    if(result.verified){
     const receipt=result.verifiedAt?null:await fetchAmazonListingPending(task.id).catch(()=>null);
     const full=await fetchTask(task.id,canViewDeliveryAssignee(staff)).catch(()=>null);if(!active)return;
     setAmazonAwaiting(null);setAmazonPhase('complete');setAmazonVerifiedAt(result.verifiedAt??receipt?.verifiedAt??null);setAmazonNotice(result.note);request.current=crypto.randomUUID();if(full)changedCallback.current(full,true);
    }else{setAmazonPhase('waiting');setAmazonNotice(result.note);}
   }catch(cause){
    if(!active)return;const status=typeof cause==='object'&&cause&&'status'in cause?Number(cause.status):0;
    if(status>=400&&status<500&&status!==429){setAmazonAwaiting(null);setAmazonPhase('failed');setAmazonNotice('');setError(cause instanceof Error?cause.message:String(cause));}
    else{setAmazonPhase('waiting');setAmazonNotice('通信の回復を待って登録結果を自動確認しています。');}
   }finally{inFlight=false;}
  }
  // Check once right away (e.g. when the panel is reopened), then every 15 seconds.
  void refreshAmazon();
  const timer=window.setInterval(()=>void refreshAmazon(),15000);return()=>{active=false;window.clearInterval(timer);};
 },[amazonAwaiting,task.id,staff.role,staff.id]);
 const disabled=busy||pending||!!amazonAwaiting||(mode==='listing'&&task.status!=='商品登録前')||(mode==='listing'&&(task.photo_review_approved!==true||context?.photo_review_approved!==true)),trade=context?.listing?.trade_key;
 const tradePayload={trade_key:trade,size:draft?.size,dropoff:draft?.dropoff,shippingMethod:draft?.shippingMethod,category:draft?.category};
 const mercari=task.sales_channel==='メルカリ';
 const mercariPost=mercari&&/^ゆうパケットポスト(?:mini)?$/.test(draft?.size??'');
 const codeIssue=draft?sellerShippingCodeError(draft):'';
 const mercariMethodSelect=draft&&<label>配送方法<select value={draft.shippingMethod} disabled={disabled} onChange={event=>changeMercariMethod(event.target.value)}>{['ゆうゆうメルカリ便','らくらくメルカリ便'].map(value=><option key={value}>{value}</option>)}</select></label>;
 const mercariSizeSelect=draft&&<label>配送サイズ<select value={draft.size} disabled={disabled} onChange={event=>change('size',event.target.value)}><option value="">選択</option>{sellerShippingSizes(draft.shippingMethod).map(value=><option key={value}>{value}</option>)}</select></label>;
 const dropoffOptions=draft?(mercari||draft.category==='小物'?['セブンイレブン','ヤマト営業所','ローソン','郵便局']:sellerShippingPlaces(draft.shippingMethod)):[];
 if(mercari&&draft?.dropoff&&!dropoffOptions.includes(draft.dropoff))dropoffOptions.unshift(draft.dropoff);
 const dropoffSelect=draft&&<label>発送場所<select value={draft.dropoff} disabled={disabled} onChange={event=>change('dropoff',event.target.value)}><option value="">選択</option>{dropoffOptions.map(value=><option key={value}>{value}</option>)}</select></label>;
 function operationProgress(kinds:string[]){return <SellerOperationProgress operation={operations.find(op=>kinds.includes(op.kind)&&(mode!=='shipping'||op.trade_key===trade))} pending={operationLocal&&kinds.includes(operationLocal.kind)?operationLocal:null}/>;}
 const photoChooser=<>{photoAnalysis.message&&<p className="muted" role="status">{photoAnalysis.message}</p>}<div className="seller-photos" aria-label="出品写真の掲載順">{[...selected.flatMap(id=>{const photo=photos.find(value=>value.id===id);return photo?[photo]:[];}),...photos.filter(photo=>!selected.includes(photo.id))].map(photo=>{const order=selected.indexOf(photo.id);return <div key={photo.id} className="seller-photo" role="group" aria-label={order<0?'出品しない写真':`写真${order+1}`}>
    <label><span>{order<0?'出品しない':`${order+1}枚目`}</span><img src={photo.url} alt="出品写真" loading="lazy"/><input type="checkbox" aria-label={order<0?'この写真を出品に含める':`${order+1}枚目を出品に含める`} checked={order>=0} disabled={disabled||order<0&&selected.length>=(amazonListing?6:10)} onChange={event=>{photosEdited.current=true;setSelected(current=>event.target.checked?[...current,photo.id]:current.filter(id=>id!==photo.id));request.current=crypto.randomUUID();}}/></label>
    {order>=0&&<div className="seller-photo-order"><button type="button" className="btn" aria-label={`写真${order+1}を前へ`} title="前へ" disabled={disabled||order===0} onClick={()=>movePhoto(photo.id,-1)}>←</button><button type="button" className="btn" aria-label={`写真${order+1}を後へ`} title="後へ" disabled={disabled||order===selected.length-1} onClick={()=>movePhoto(photo.id,1)}>→</button></div>}
   </div>;})}</div></>;
 const latestMessages=operations.find(op=>op.kind==='message_sync'&&op.status==='succeeded'&&op.trade_key===context?.listing?.trade_key)?.result.messages;

 return <section className={`task-detail-inline seller-panel${mode==='listing'&&!amazonListing?' seller-listing-layout':''}`} aria-label={`${task.sku}の${mode==='listing'?'出品':mode==='shipping'?'発送':'取引メッセージ'}`}>
  {error&&!(amazonListing&&draft&&descriptionSource)&&<p className="error" role="alert">{error}</p>}
  {mode==='listing'&&context&&context.photo_review_approved!==true&&<p role="status">管理アプリで商品写真の承認が必要です。</p>}
  {!draft?<p>読み込み中…</p>:mode==='listing'?<>
   {descriptionSource&&<DescriptionEditor key={task.id} task={descriptionSource.task} listingSkus={listingSkus} onSaved={descriptionSaved} embedded={{
    value:draft,manufacturer:descriptionSource.maker,disabled,onSaving:setBusy,onChange:updateDescription,
    yearPhotoKey:amazonListing&&!amazonAwaiting&&photos.length?photos.map(photo=>photo.id).join(','):undefined,
    suggestedAccessories:photoAnalysis.overview&&selected[0]===photoAnalysis.overview?photoAnalysis.accessories:undefined,
    beforeActions:amazonListing?photoChooser:undefined,
    actions:amazonListing?(persistDetails,readingYear)=><button type="button" className="btn primary" disabled={disabled||amazonPhase==='complete'||readingYear||photoAnalysis.reading||selected.length<1||selected.length>6} onClick={()=>void beginAmazonListing(persistDetails)}>出品</button>:undefined,
    afterActions:amazonListing&&error?<p className="error" role="alert">{error}</p>:undefined,
   }}/>}
   {!amazonListing&&<>
   <div className="seller-form">
    <label className="seller-short">{task.sales_channel==='ヤフオク'?'開始価格':'価格'}<input type="number" min={1} step={1} value={draft.price} disabled={disabled} onChange={event=>change('price',Number(event.target.value))}/></label>
    <label>送料負担<select value={draft.shippingPayer} disabled={disabled} onChange={event=>change('shippingPayer',event.target.value)}>{['出品者負担','購入者負担'].map(value=><option key={value}>{value}</option>)}</select></label>
    {mercari?<>{mercariMethodSelect}{mercariSizeSelect}{dropoffSelect}</>:<label>配送方法<input value={draft.shippingMethod} readOnly/></label>}
    <label className="seller-short">発送元<input value={draft.origin} disabled={disabled} readOnly={yahooListing} onChange={event=>change('origin',event.target.value)}/></label>
    <label className="seller-short">発送までの日数<select value={draft.dispatchDays} disabled={disabled} onChange={event=>change('dispatchDays',event.target.value)}>{['1〜2日','2〜3日',yahooListing?'3〜7日':'4〜7日'].map(value=><option key={value}>{value}</option>)}</select></label>
    {yahooListing&&<>
     <label>配送サイズ<select value={draft.size} disabled={disabled||yahooSizeLocked} onChange={event=>change('size',event.target.value)}><option value="">選択</option>{yahooListingSizes(draft.shippingMethod).map(value=><option key={value} value={value}>{/^\d+$/.test(value)?value+'サイズ':value}</option>)}</select></label>
     {yahooNeedsWeight&&<label>梱包後の重さ<select value={draft.weightKg??''} disabled={disabled||yahooSizeLocked&&!!draft.weightKg} onChange={event=>change('weightKg',event.target.value)}><option value="">選択</option>{yahooWeights.map(value=><option key={value} value={value}>{value}kg以内</option>)}</select></label>}
    </>}
    <label>出品カテゴリ<input value={draft.listingCategory??''} disabled={disabled} maxLength={200} placeholder="サイトのカテゴリ名" onChange={event=>change('listingCategory',event.target.value)}/></label>
    {task.sales_channel==='ヤフオク'&&<><label className="seller-short">終了までの日数<input type="number" min={1} max={7} value={draft.auctionDays} disabled={disabled} onChange={event=>change('auctionDays',Number(event.target.value))}/></label><label className="seller-short">終了時間帯<select value={draft.closingHour} disabled={disabled} onChange={event=>change('closingHour',Number(event.target.value))}>{Array.from({length:24},(_,hour)=><option key={hour} value={hour}>{hour}時台</option>)}</select></label><div className="seller-auction-options" role="group" aria-label="オークション設定"><label><input type="checkbox" checked={draft.autoExtend} disabled={disabled} onChange={event=>change('autoExtend',event.target.checked)}/>自動延長</label><label><input type="checkbox" checked={draft.autoRelist} disabled={disabled} onChange={event=>change('autoRelist',event.target.checked)}/>自動再出品</label></div></>}
   </div>
   {photoChooser}
   {categoryError&&<p className="error" role="alert">{categoryError}</p>}
   {yahooListing&&draft.category==='小物'&&<p>{yahooRule?.source==='sale'?(yahooNeedsWeight&&!yahooRule.weightKg?'前回の配送サイズを適用しました。梱包後の重さを入力してください。':'前回の販売データを適用しました。'):'前回の販売データから、この配送会社で使えるサイズを確認できませんでした。梱包後の配送条件を入力してください。'}</p>}
   {yahooShippingError&&<p className="error" role="alert">{yahooShippingError}</p>}
   <button type="button" className="btn primary" disabled={disabled||photoAnalysis.reading||!!categoryError||!!yahooShippingError||!draft.title.trim()||!draft.description.trim()||!draft.listingCategory?.trim()||draft.price<1||!draft.origin||!draft.condition||selected.length<1||selected.length>10} onClick={()=>setConfirming('listing')}>出品</button>
   {context?.listing&&<a href={context.listing.url} target="_blank" rel="noreferrer">出品した商品を確認</a>}
   </>}
   {!amazonListing&&staff.role==='admin'&&<LineShippingSettings key={task.id} itemId={task.id} draft={draft} overviewId={selected[0]} listing/>}
  </>:!trade?<p>販売先の取引情報の取得待ちです。</p>:mode==='shipping'?<>
   <div className="seller-form">
    {mercari?<>{mercariMethodSelect}{mercariSizeSelect}</>:<>
     {draft.category==='小物'&&<label>配送方法<select value={draft.shippingMethod} disabled={disabled} onChange={event=>change('shippingMethod',event.target.value)}>{['おてがる配送（ヤマト運輸）','おてがる配送（日本郵便）'].map(value=><option key={value}>{value}</option>)}</select></label>}
     <label>配送サイズ<select value={draft.size} disabled={disabled} onChange={event=>change('size',event.target.value)}><option value="">選択</option>{(draft.category==='小物'?['100','140',...SMALL_PACKAGES.filter(value=>value.name!=='ゆうパケットポスト').map(value=>value.name)]:sellerShippingSizes(draft.shippingMethod)).map(value=><option key={value}>{value}</option>)}</select></label>
    </>}
    {dropoffSelect}
   </div>
   {draft.size&&sellerShippingError(draft)&&<p className="error" role="alert">{sellerShippingError(draft)}</p>}
   {draft.category==='小物'&&<div>{SMALL_PACKAGES.filter(value=>mercari?sellerShippingSizes(draft.shippingMethod).includes(value.name):value.name!=='ゆうパケットポスト').map(value=><p key={value.name}>{value.name}：{value.dimensions}</p>)}</div>}
   {mercariPost?<p>メルカリの取引画面で専用資材のコードを読み取り、郵便ポストへ投函してください。 <a href={`https://jp.mercari.com/transaction/${encodeURIComponent(context?.listing?.external_id??'')}`} target="_blank" rel="noreferrer">取引画面を開く</a></p>:/ゆうパケットポストmini/.test(draft.size)?<>
    <button type="button" className="btn" disabled={disabled||!!sellerShippingError(draft)} onClick={()=>setCamera(true)}>専用資材のコードを読む</button>{camera&&<PackageCamera onRead={onRead} onClose={()=>setCamera(false)}/>}
    {code&&<><p>専用資材のコードを読み取りました。</p><button type="button" className="btn" disabled={disabled} onClick={()=>void submit('register_package',{...tradePayload,code})}>対象取引へ登録</button></>}
   </>:<><div className="seller-shipping-actions"><button type="button" className="btn" data-direction="forward" disabled={busy||!!codeIssue||(pending&&!operations.some(op=>op.kind==='shipping_code'&&op.status==='uncertain'&&op.trade_key===trade))} onClick={()=>void (pending?retryShipping(tradePayload):submit('shipping_code',tradePayload))}>発送コード表示</button>{<MarketplaceShippingHandoff key={task.id+':'+trade} itemId={task.id} tradeKey={trade} disabled={disabled}/>}</div>{codeIssue&&!sellerShippingError(draft)&&<p className="error" role="alert">{codeIssue}</p>}{qr&&!codeIssue&&<img src={qr} className="seller-qr" alt="対象取引の配送コード"/>}</>}
   {(mercariPost||/ゆうパケットポストmini/.test(draft.size))&&<div className="seller-shipping-actions"><MarketplaceShippingHandoff key={task.id+':'+trade} itemId={task.id} tradeKey={trade} disabled={disabled}/></div>}
   {staff.role==='admin'&&<LineShippingSettings key={task.id+':'+trade} itemId={task.id} draft={draft}/>}
  </>:<>
   <button type="button" className="btn" disabled={disabled} onClick={()=>void submit('message_sync',tradePayload)}>メッセージを取得</button>
   {Array.isArray(latestMessages)&&latestMessages.map((entry,index)=><p key={index} className="seller-preview">{entry&&typeof entry==='object'&&typeof entry.body==='string'?entry.body:''}</p>)}
   <textarea aria-label="取引相手へのメッセージ" value={message} maxLength={2000} disabled={disabled} onChange={event=>{setMessage(event.target.value);request.current=crypto.randomUUID();}}/>
   <button type="button" className="btn primary" disabled={disabled||!message.trim()} onClick={()=>{if(window.confirm('取引相手へ送信しますか？'))void submit('message_send',{...tradePayload,body:message.trim()});}}>送信</button>
  </>}
  {mode==='listing'&&operations.some(op=>op.kind==='listing'&&op.status==='uncertain')&&<div><label>出品済み商品のURL（任意）<input type="url" value={listingUrl} disabled={busy||!!watching} onChange={event=>setListingUrl(event.target.value)}/></label><button type="button" className="btn" disabled={busy||!!watching} onClick={()=>void checkListing()}>出品結果を確認</button></div>}
  {confirming&&<WorkDateConfirmation title={amazonListing?`${task.sales_channel==='FBA2'||task.sales_channel==='自己発送2'?'Amazon2':'Amazon1'}に${amazonConfirmation?.price.toLocaleString('ja-JP')??''}円で出品しますか。`:(marketplaceAccountLabel(context?.listing_account_id) ? `${marketplaceAccountLabel(context?.listing_account_id)}に出品しますか。` : '出品しますか。')} purchasedAt={task.purchased_at} savedDate={task.packed_on} onCancel={()=>{setConfirming(null);setAmazonPhase(current=>current==='confirmation'?null:current);}} onConfirm={async date=>{if(lock.current||disabled)return;if(!draft)throw new Error('出品内容を確認してください。');if(confirming==='listing'&&(categoryError||yahooShippingError))throw new Error(categoryError||yahooShippingError);if(confirming==='listing_complete')await completeAmazonListing(date);else{lock.current=true;setBusy(true);setOperationLocal({kind:'listing',state:'sending'});try{const {expected_revision,...payload}={...draft,work_completed_on:date,photos:selected.flatMap(id=>{const photo=photos.find(value=>value.id===id);return photo?[photo.url]:[];}),expected_revision:context?.revision};await queueSellerOperation(task.id,'listing',{...payload,...(yahooListing?{yahoo_shipping_rule:1}:{}),expected_revision},request.current);request.current=crypto.randomUUID();setContext(await fetchSellerContext(task.id));setOperationLocal(null);}catch(cause){setOperationLocal({kind:'listing',state:'uncertain'});throw cause;}finally{lock.current=false;setBusy(false);}}}}/>}
  {/* 出品・発送・取引メッセージの状況の枠は、どの販売状態でも閉じるの下の履歴の先頭に出す（2026-11-24 ユーザー指定・案4） */}
  {mode==='listing'?(amazonListing?<OperationProgress phase={amazonPhase} note={amazonNotice} verifiedAt={amazonVerifiedAt}/>:operationProgress(['listing'])):mode==='shipping'?operationProgress(['shipping_code','register_package','ship_notice']):operationProgress(['message_sync','message_send'])}
  <div className="seller-history" aria-live="polite">{operations.filter(op=>mode!=='shipping'||(op.trade_key===trade&&['shipping_code','register_package','ship_notice'].includes(op.kind))).map(op=><p key={op.id}>{operationLabel(op.kind)}：{statusText(op)}{op.status==='succeeded'&&op.finished_at&&<>（<time dateTime={op.finished_at}>{formatOperationTime(op.finished_at)}</time>）</>}{typeof op.result.last_check_note==='string'?'：'+op.result.last_check_note:typeof op.result.note==='string'?'：'+op.result.note:''}{op.status==='running'&&Date.now()-Date.parse(op.created_at)>600000?'。結果を確認するまで再実行しません。':''}</p>)}</div>
 </section>;
}
