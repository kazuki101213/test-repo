import {useEffect,useRef,useState} from 'react';
import DateInput from '../components/DateInput';
import FbaLabelControls from './FbaLabelControls';
import {amount,fbaCarrierGroups,fbaCarrierName,InboundRequestError,inboundRequest,preferredFbaCarrier,tokyoDate,type Box,type InboundPlan} from './fbaInboundApi';
import {canResizeBoxes,needsWindow,validateBoxes,type Transport} from '../../../../supabase/functions/amazon-fba-inbound/workflow';

const shipmentStatus:Record<string,string>={UNCONFIRMED:'未確定',WORKING:'発送前',READY_TO_SHIP:'発送前',SHIPPED:'発送済み',
 IN_TRANSIT:'配送中',DELIVERED:'到着済み',CHECKED_IN:'到着確認済み',RECEIVING:'受領中',CLOSED:'受領完了',CANCELLED:'取消済み',
 DELETED:'削除済み',ABANDONED:'中止'};
const blank=(items:string[]=[]):Box=>({length:0,width:0,height:0,weight:0,items});
const serial=(sku:string)=>sku.split('-')[0]||sku;
const shortDate=(s:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'}).format(new Date(s));
const sellerCentralShipments='https://sellercentral.amazon.co.jp/gp/ssof/shipping-queue.html';
type PrepReview={owners:Record<string,{prepOwner:string;labelOwner:string}>;requirements:Record<string,string[]>};
type PlanResult={plan:InboundPlan;prepReview?:PrepReview};

function shippingApprovalKey(work:InboundPlan['work'],options:Transport[]){
 const charges=work.placement?.fees?.map(fee=>[fee.code,fee.amount]);
 const shipments=[...options].sort((a,b)=>a.shipmentId.localeCompare(b.shipmentId)).map(option=>[
  option.shipmentId,option.id,fbaCarrierName(option),option.solution,option.quote?.code,option.quote?.amount,
 ]);
 return JSON.stringify([work.placement?.id,work.placement?.shipmentIds,work.shipDate,charges,shipments]);
}

export default function FbaInboundPlan({plan,onUpdate}:{plan:InboundPlan;onUpdate:(p:InboundPlan)=>void}){
 const items=plan.fba_inbound_items;
 const work=plan.work;
 const resizePending=plan.pending?.action==='resizeBoxes';
 const [boxes,setBoxes]=useState<Box[]>(()=> (resizePending?plan.pending?.boxes:undefined)??work.boxes??[blank(items.map(i=>i.item_id))]);
 const [resizing,setResizing]=useState(resizePending);
 const [dirty,setDirty]=useState(!work.boxes),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [option,setOption]=useState(''),[date,setDate]=useState(()=>work.shipDate||tokyoDate(3)),[selected,setSelected]=useState<Record<string,string>>({});
 const [tracking,setTracking]=useState<Record<string,string>>({}),[windowIds,setWindowIds]=useState<Record<string,string>>({});
 const [labelShipmentId,setLabelShipmentId]=useState('');
 const [labelError,setLabelError]=useState('');
 const [prep,setPrep]=useState<PrepReview|null>(null);
 const [failedPoll,setFailedPoll]=useState('');
 const [shippingApproval,setShippingApproval]=useState<string|null>(null);
 const automaticAttempt=useRef('');
 const editable=['draft','created','packing-options','packing-confirmed'].includes(plan.stage);
 const canResize=canResizeBoxes(plan.stage)&&!!work.boxes?.length;
 const editingSize=resizing&&canResize;
 const canSendBoxes=plan.stage==='packing-confirmed';
 const blocked=busy||!!plan.pending;
 const requestBody={id:plan.id,revision:plan.revision};
 const groups=[...new Set(Object.values(work.groups??{}))];
 const packing=(work.packing??[]).filter(p=>!p.expiration||Date.parse(p.expiration)>Date.now());
 const singlePacking=packing.length===1?packing[0]:undefined;
 const packingChoice=singlePacking??packing.find(p=>p.id===option);
 const autoPackingOptions=plan.stage==='created';
 const autoPackingId=plan.stage==='packing-options'&&singlePacking?.fees.every(fee=>fee.amount===0)?singlePacking.id:undefined;
 const autoPlacements=plan.stage==='packed';
 let autoSendBoxes=false;
 if(canSendBoxes&&!dirty&&work.groups&&work.boxes){
  try{validateBoxes(work.boxes,items,work.groups);autoSendBoxes=true;}catch{/* The box assignments need review before sending. */}
 }

 useEffect(()=>{
  const op=plan.pending?.op;
  if(!op||op===failedPoll)return;
  let active=true;
  let failures=0;
  let timer:ReturnType<typeof setTimeout>;
  const retryDelays=[2500,5000,10000];
  const run=(delay=2500)=>{timer=setTimeout(async()=>{
   try{const {plan:next,prepReview}=await inboundRequest<PlanResult>('poll',{id:plan.id});
    if(active){
     failures=0;
     if(resizePending)finishResize(next);
     onUpdate(next);setPrep(prepReview??null);setError('');
     if(next.work.notice)setShippingApproval(null);
     if(next.pending?.op===op)run();
    }
   }catch(cause){
    if(!active)return;
    // Retry checking the existing operation. Never submit it to Amazon again.
    if(cause instanceof InboundRequestError&&cause.retryable&&failures<retryDelays.length){
     run(retryDelays[failures++]);
     return;
    }
    setFailedPoll(op);setError(String((cause as Error).message));
   }
  },delay);};
  run();
  return()=>{active=false;clearTimeout(timer);};
 },[plan.id,plan.pending?.op,failedPoll]);

 function finishResize(next:InboundPlan){
  if(next.pending||next.stage!=='packed'||next.work.notice||!next.work.boxes)return;
  setBoxes(next.work.boxes);setDirty(false);setResizing(false);
  setOption('');setSelected({});setShippingApproval(null);
 }
 function stopResize(){
  setBoxes(work.boxes??[]);setResizing(false);setError('');
 }
 async function apply(action:string,fields:Record<string,unknown>={}){
  setBusy(true);setError('');
  try {
   let request=requestBody;
   if(action==='create'&&dirty){
    const {plan:saved}=await inboundRequest<PlanResult>('saveBoxes',{...request,boxes});
    onUpdate(saved);setBoxes(saved.work.boxes??boxes);setDirty(false);
    request={id:saved.id,revision:saved.revision};
   }
   const {plan:next,prepReview}=await inboundRequest<PlanResult>(action,{...request,...fields});
   if((action==='recover'&&resizePending)||action==='resizeBoxes')finishResize(next);
   onUpdate(next);setPrep(prepReview??null);if(action==='boxes'){setBoxes(next.work.boxes??boxes);setDirty(false);}
   if(action==='confirmTransport')setShippingApproval(null);
  }catch(cause){
   if(action==='confirmPlacement'||action==='confirmTransport')setShippingApproval(null);
   setError((cause as Error).message);
   try {onUpdate((await inboundRequest<{plan:InboundPlan}>('get',{id:plan.id})).plan);}catch{/* Keep the current plan open. */}
  }finally{setBusy(false);}
 }
 async function label(shipment:string){
  // Open the tab during the click so browsers keep the user's activation.
  const pdfTab=window.open('', '_blank');
  setBusy(true);setLabelError('');
  try {
   if(pdfTab){
    pdfTab.opener=null;
    pdfTab.document.title='配送ラベル';
    pdfTab.document.body.style.fontFamily=window.getComputedStyle(document.body).fontFamily;
    pdfTab.document.body.textContent='配送ラベルを読み込んでいます…';
   }
   const response=await inboundRequest<Blob>('label',{...requestBody,shipment});
   if(pdfTab?.closed)return;
   const url=URL.createObjectURL(new Blob([response],{type:'application/pdf'}));
   window.setTimeout(()=>URL.revokeObjectURL(url),60_000);
   if(pdfTab)pdfTab.location.replace(url);
   else window.location.assign(url);
  }catch(cause){
   pdfTab?.close();
   setLabelError((cause as Error).message);
  }finally{setBusy(false);}
 }
 function editBoxes(next:Box[]){setBoxes(next);setDirty(true);}
 function changeBox(index:number,patch:Partial<Box>){editBoxes(boxes.map((b,j)=>index===j?{...b,...patch}:b));}
 function assign(item:string,index:number){
  editBoxes(boxes.map((b,j)=>({...b,items:[...b.items.filter(id=>id!==item),...(j===index?[item]:[])]})));
 }
 function act(text:string,action:string,fields:Record<string,unknown>={},disabled=false,style=''){
  return <button type="button" className={'btn '+style} disabled={blocked||disabled} onClick={()=>void apply(action,fields)}>{text}</button>;
 }
 const placements=(work.placements??[]).filter(p=>p.shipmentIds.length&&(!p.expiration||Date.parse(p.expiration)>Date.now()));
 const placement=placements.find(p=>p.id===option)
  ??placements.find(p=>p.id===work.placement?.id)
  ??(placements.length===1?placements[0]:undefined);
 const today=tokyoDate();
 const parsedDate=new Date(date+'T00:00:00Z');
 const validDate=/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=today&&Number.isFinite(+parsedDate)&&parsedDate.toISOString().slice(0,10)===date;
 const canQuote=!editingSize&&(plan.stage==='placement-options'||plan.stage==='transport-options');
 const quoteInProgress=plan.pending?.action==='transport';
 const showCarriers=plan.stage==='transport-options'&&!quoteInProgress&&!!placement&&placement.id===work.placement?.id&&date===work.shipDate&&validDate;
 const quotePlacementId=canQuote&&!showCarriers&&validDate?placement?.id:undefined;
 const carrierRows=showCarriers?(placement?.shipmentIds??[]).map(id=>{
  const options=(work.transport??[]).filter(t=>t.shipmentId===id&&(!t.expiration||Date.parse(t.expiration)>Date.now())
   &&(t.solution!=='AMAZON_PARTNERED_CARRIER'||t.quote)
   &&t.preconditions.every(key=>key==='CONFIRMED_DELIVERY_WINDOW'||key==='CONFIRMED_PLACEMENT_REQUIRED'));
  const choice=selected[id]===undefined?preferredFbaCarrier(options):options.find(t=>t.id===selected[id]);
  return {id,options,choice};
 }):[];
 const chosen=carrierRows.flatMap(row=>row.choice?[row.choice]:[]);
 const missingCarriers=carrierRows.some(row=>!row.options.length);
 const finalOptions=work.selections??[];
 const confirmTogether=chosen.length>0&&!chosen.some(needsWindow);
 const autoConfirmTransport=plan.stage==='placement-confirmed'&&shippingApproval!==null&&!!work.shipDate&&work.shipDate>=today&&
  finalOptions.length>0&&finalOptions.every(t=>!needsWindow(t)&&(!t.expiration||Date.parse(t.expiration)>Date.now()))&&
  shippingApproval===shippingApprovalKey(work,finalOptions);
 const missingWindowId=plan.stage==='placement-confirmed'?finalOptions.find(t=>needsWindow(t)&&!work.selectedWindows?.[t.shipmentId]&&
  !work.windows?.[t.shipmentId])?.shipmentId:undefined;
 const problem=error||work.notice;
 useEffect(()=>{
  if(shippingApproval&&plan.stage==='placement-confirmed'&&!autoConfirmTransport)setShippingApproval(null);
  if(blocked||problem||editingSize)return;
  let action:string;
  let fields:Record<string,unknown>={};
  if(autoPackingOptions)action='packing';
  else if(autoPackingId){action='choosePacking';fields={option:autoPackingId,automatic:true};}
  else if(autoSendBoxes)action='boxes';
  else if(autoPlacements)action='placements';
  else if(quotePlacementId){action='transport';fields={option:quotePlacementId,shipDate:date};}
  else if(missingWindowId){action='windows';fields={shipment:missingWindowId};}
  else if(autoConfirmTransport){action='confirmTransport';fields={confirmed:true};}
  else return;
  const attempt=`${plan.revision}:${action}:${JSON.stringify(fields)}`;
  if(automaticAttempt.current===attempt)return;
  const run=()=>{automaticAttempt.current=attempt;void apply(action,fields);};
  if(action==='transport'){
   const timer=setTimeout(run,500);
   return()=>clearTimeout(timer);
  }
  run();
 },[autoPackingOptions,autoPackingId,autoSendBoxes,autoPlacements,quotePlacementId,date,missingWindowId,shippingApproval,autoConfirmTransport,blocked,problem,editingSize,plan.stage,plan.revision]);
 const ready=plan.stage==='ready';
 const labelDestinations=ready?work.placement?.shipmentIds??[]:[];
 const labelDestination=labelDestinations.includes(labelShipmentId)?labelShipmentId:labelDestinations[0];
 const sent=work.shipments?.some(s=>s.trackingSaved||['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'].includes(s.status));
 const canCancel=!ready&&!sent&&plan.stage!=='cancelled'&&!plan.pending;
 const sender=plan.sender;
 return <section className="card fba-workflow" aria-label={plan.name}>
  <div className="fba-selection-group-heading">
   <h3>{plan.name} <span className="inventory-label">{plan.account}</span></h3>
  </div>
  <div className="fba-work-grid">
   <section className="fba-work-box">
    <h4>納品商品</h4>
    {boxes.map((box,index)=><div className="fba-carton" key={index}>
     <div className="fba-work-actions"><strong>箱 {index+1}</strong>{editable&&boxes.length>1&&<button className="btn" type="button" disabled={blocked} onClick={()=>editBoxes(boxes.filter((_,j)=>index!==j))}>箱を削除</button>}</div>
     <div className="fba-carton-fields">{(['length','width','height','weight'] as const).map((field,i)=><label key={field}>{['長さ (cm)','幅 (cm)','高さ (cm)','重量 (kg)'][i]}<input type="number" min="0.01" step="0.01" inputMode="decimal" disabled={!(editable||editingSize)||blocked} value={box[field]||''} style={{width:`calc(${String(box[field]||'').length}ch + 32px)`}} onChange={event=>{
      const patch={[field]:Number(event.target.value)};
      if(editingSize)setBoxes(current=>current.map((row,i)=>i===index?{...row,...patch}:row));
      else changeBox(index,patch);
     }}/></label>)}</div>
    </div>)}
    {canResize&&<div className="fba-work-actions">
     {editingSize?<>
      {act('変更','resizeBoxes',{dimensions:boxes.map(({length,width,height,weight})=>({length,width,height,weight}))},
       !boxes.every(box=>[box.length,box.width,box.height,box.weight].every(value=>Number.isFinite(value)&&value>0)),'primary')}
      <button className="btn" type="button" disabled={blocked} onClick={stopResize}>閉じる</button>
     </>:<button className="btn" type="button" disabled={blocked} onClick={()=>{setResizing(true);setError('');}}>変更</button>}
    </div>}
    {editable&&<div className="fba-work-actions"><button type="button" className="btn" disabled={blocked||boxes.length>=items.length} onClick={()=>editBoxes([...boxes,blank()])}>追加</button></div>}
    <ul className="fba-work-items">{items.map(item=>{
     const boxIndex=boxes.findIndex(box=>box.items.includes(item.item_id));
     return <li key={item.item_id}>
      <div className="fba-work-item-details">
       <strong className="fba-item-name" title={item.title}>{serial(item.sku)} {item.title}</strong>
       <span>{item.sku} ／ {item.asin}</span>
       {editable&&groups.length>1&&<small>梱包グループ {groups.indexOf(work.groups?.[item.item_id]??'')+1}</small>}
      </div>
      <div className="fba-work-item-controls">
       {editable?<select id={'box-'+item.item_id} aria-label={`${item.sku} の箱`} disabled={blocked} value={boxIndex} onChange={e=>assign(item.item_id,Number(e.target.value))}>
        <option value="-1">未割当</option>{boxes.map((_,i)=><option key={i} value={i}>箱 {i+1}</option>)}
       </select>:boxIndex>=0&&<span>箱 {boxIndex+1}</span>}
       <span>1点{item.published_at?'・出品中':''}</span>
      </div>
     </li>;
    })}</ul>
    {canSendBoxes&&(autoSendBoxes&&!problem?<p role="status">箱情報をAmazonに送信しています…</p>:act('送信','boxes',{boxes},false,'primary'))}
   </section>
   <div className="fba-work-sidebar">
   <section className="fba-work-box"><h4>発送元</h4><p>{sender.name}<br/>〒{sender.postalCode}<br/>{sender.stateOrProvinceCode}{sender.city}{sender.addressLine1}{sender.addressLine2}<br/>{sender.phoneNumber}</p>
   <dl className="fba-work-settings">
    <dt>ワークフロー名</dt><dd>{plan.name}</dd>
    <dt>商品数</dt><dd>{items.length}点（各1点）</dd>
    {plan.amazon_id&&<><dt>Amazon納品プランID</dt><dd>{plan.amazon_id}</dd></>}
   </dl></section>
   {plan.stage!=='cancelled'&&<section className="fba-work-box fba-operation-box">
   <h4>操作</h4>
   {plan.stage==='draft'&&prep&&<div role="status"><p>Amazonが指定した梱包・ラベル条件を確認してください。</p>
     {Object.entries(prep.owners).map(([id,owner])=>{
      const requirements=prep.requirements[id]??[];
      const labelOnly=requirements[0]==='NONE'&&requirements.includes('ITEM_LABELING')&&requirements.every(type=>['NONE','ITEM_LABELING','ITEM_NO_PREP'].includes(type));
      return <p key={id}>{serial(items.find(i=>i.item_id===id)?.sku??'')}：{owner.prepOwner==='NONE'||labelOnly?'梱包不要':`出品者が梱包（Amazon指定：${requirements.join('、')}）`} ／ {owner.labelOwner==='NONE'?'ラベル不要':'出品者がラベル貼付'}</p>;
     })}
    </div>}
   {labelDestinations.length>1&&<label className="fba-work-field fba-label-destination">納品先<select aria-label="納品先" value={labelDestination} disabled={blocked} onChange={event=>{setLabelShipmentId(event.target.value);setLabelError('');}}>
    {labelDestinations.map((id,index)=><option value={id} key={id}>{work.shipments?.find(s=>s.id===id)?.warehouse||`納品先 ${index+1}`}</option>)}
   </select></label>}
   {plan.stage==='draft'&&<div className="fba-work-actions"><button type="button" className="btn primary" disabled={blocked} onClick={()=>{
     if(prep||window.confirm(`${plan.account}に「${plan.name}」を作成しますか？`))void apply('create',{autoPrep:true,acceptPrep:!!prep});
    }}>{prep?'指定条件で納品プランを作成':'Amazonに納品プランを作成'}</button></div>}
   <FbaLabelControls productOnly
    afterLabels={canCancel&&<button className="btn fba-work-cancel" type="button" disabled={busy} onClick={()=>{if(window.confirm('この納品を取り消しますか？'))void apply('cancel');}}>納品取消</button>}
    shippingLabel={<button type="button" className="btn primary" disabled={blocked||!labelDestination} onClick={()=>{if(labelDestination)void label(labelDestination);}}>配送ラベル</button>}
    items={items.filter(i=>!i.published_at&&(work.owners?.[i.item_id]?.labelOwner??'SELLER')==='SELLER').map(i=>({
    id:i.item_id,sku:i.sku,sales_channel:i.sales_channel,
   }))}/>
   {labelError&&<p className="error" role="alert">{labelError}</p>}
   {plan.stage==='draft'&&<>
    {plan.pending?.createAfterPrep&&<p role="status">Amazonに梱包不要を登録しています。反映後に納品プランを作成します。</p>}
    {(error||work.notice)&&<p className="error" role="alert">{error||work.notice}</p>}
   </>}
   {autoPackingOptions&&(error||work.notice?act('梱包方法を再取得','packing'):<p role="status">梱包方法を取得しています…</p>)}
   {plan.stage==='packing-options'&&(autoPackingId&&!error&&!work.notice
    ? <p role="status">料金のかからない梱包方法を自動で確定しています…</p>
    : <>
     {singlePacking&&!autoPackingId&&<p>梱包方法　{singlePacking.groups.length}グループ ／ {amount(singlePacking.fees)}</p>}
     {packing.length>1&&<label className="fba-work-field">梱包方法<select aria-label="梱包方法" disabled={blocked} value={packingChoice?.id??''} onChange={e=>setOption(e.target.value)}><option value="">選択してください</option>
     {packing.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.groups.length}グループ ／ {amount(p.fees)}</option>)}</select></label>}
     {!packing.length&&<p>選択できる梱包方法がありません。</p>}
     <div className="fba-work-actions">
      {!autoPackingId&&packing.length>0&&<button className="btn primary" type="button" disabled={blocked||!packingChoice} onClick={()=>{if(packingChoice&&window.confirm('表示の梱包方法と料金で確定しますか？'))void apply('choosePacking',{option:packingChoice.id,confirmed:true});}}>梱包方法を確定</button>}
      {(!packing.length||problem)&&act('梱包方法を再取得','packing')}
     </div>
    </>)}
   {autoPlacements&&!editingSize&&(error||work.notice?act('再取得','placements'):<p role="status">納品先の候補を取得しています…</p>)}
   {canQuote&&<>
    <div className="fba-work-actions fba-transport-actions">
    <label className="fba-work-field">納品先の候補<select aria-label="納品先の候補" value={placement?.id??''} disabled={blocked||!placements.length} onChange={e=>{setOption(e.target.value);setSelected({});}}>
     {placements.length!==1&&<option value="" disabled>選択してください</option>}
     {placements.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.shipmentIds.length}か所 ／ {amount(p.fees)}</option>)}</select></label>
    <label className="fba-work-field">出荷日<DateInput aria-label="出荷日" value={date} min={today} onChange={e=>{setDate(e.target.value);setSelected({});}} disabled={blocked}/></label>
    <label className="fba-work-field">配送モード<select aria-label="配送モード" value="SPD" disabled><option value="SPD">個口配送（SPD）</option></select></label>
    {!plan.pending&&placement&&validDate&&(problem||missingCarriers)&&act('配送方法を再取得','transport',{option:placement.id,shipDate:date},false,'primary')}
    {!plan.pending&&(!placements.length||problem||missingCarriers)&&act('納品先を再取得','placements')}</div>
    {quotePlacementId&&!problem&&<p role="status">配送料の見積もりを取得しています…</p>}
    {showCarriers&&carrierRows.length>0&&<>
    {carrierRows.map(({id,options,choice},i)=>{
     const label=carrierRows.length===1?'配送業者':`配送業者（${work.shipments?.find(s=>s.id===id)?.warehouse||`納品先 ${i+1}`}）`;
     const {primary,other}=fbaCarrierGroups(options);
     const renderOption=(t:(typeof options)[number])=><option key={t.id} value={t.id}>{fbaCarrierName(t)} ／ {t.solution==='USE_YOUR_OWN_CARRIER'?'配送会社と直接精算':amount(t.quote?[t.quote]:[])}</option>;
     return <label className="fba-work-field fba-carrier-field" key={id}>{label}
      <select aria-label={label} value={choice?.id??''} disabled={blocked||!options.length} onChange={e=>setSelected({...selected,[id]:e.target.value})}>
       <option value="">{options.length?'配送業者を選択':'選択できる配送業者がありません'}</option>
       {primary.map(renderOption)}
       {other.length>0&&<optgroup label="それ以外の配送業者">{other.map(renderOption)}</optgroup>}
      </select></label>;
    })}
    <button className="btn primary" type="button" disabled={blocked||chosen.length!==carrierRows.length} onClick={()=>{
     const title=confirmTogether?'納品先と配送を確定しますか？':'納品先を確定しますか？';
     const destinations=chosen.map((t,i)=>{
      const warehouse=work.shipments?.find(s=>s.id===t.shipmentId)?.warehouse||`納品先 ${i+1}`;
      return `${warehouse} ／ ${fbaCarrierName(t)}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`;
     });
     if(window.confirm([title,`出荷日：${date}`,`納品先の料金：${amount(work.placement?.fees)}`,...destinations].join('\n'))){
      setShippingApproval(confirmTogether?shippingApprovalKey(work,chosen):null);
      void apply('confirmPlacement',{options:chosen.map(t=>t.id),confirmed:true});
     }
    }}>{confirmTogether?'納品先と配送を確定':'納品先を確定'}</button></>}
   </>}
   {plan.stage==='placement-confirmed'&&<>
    {finalOptions.filter(needsWindow).map((t,i)=>{
     const windows=work.windows?.[t.shipmentId]?.filter(w=>!w.expiration||Date.parse(w.expiration)>Date.now());
     return <div className="fba-carton" key={t.shipmentId}>
     <strong>{work.shipments?.find(s=>s.id===t.shipmentId)?.warehouse||`納品先 ${i+1}`}：{fbaCarrierName(t)}</strong>
     {work.selectedWindows?.[t.shipmentId]?<p>到着期間を確定済み</p>:<div className="fba-work-actions">
     {(windows?.length===0||problem)&&act('到着期間を再取得','windows',{shipment:t.shipmentId})}
     {!windows&&!problem&&<span role="status">到着期間の候補を取得しています…</span>}
     {!!windows?.length&&<><label>到着期間 <select disabled={blocked} value={windowIds[t.shipmentId]??''} onChange={e=>setWindowIds({...windowIds,[t.shipmentId]:e.target.value})}><option value="">選択してください</option>
      {windows.map(w=><option key={w.id} value={w.id}>{shortDate(w.start)}〜{shortDate(w.end)}</option>)}</select></label>
      {act('到着期間を確定','chooseWindow',{shipment:t.shipmentId,option:windowIds[t.shipmentId]},!windows.some(w=>w.id===windowIds[t.shipmentId]))}</>}
     </div>}
    </div>;})}
    {plan.pending?.action==='confirmTransport'||(autoConfirmTransport&&!problem)?<p role="status">配送を確定しています…</p>:
     <button className="btn primary" type="button" disabled={blocked||!finalOptions.length||finalOptions.some(t=>needsWindow(t)&&!work.selectedWindows?.[t.shipmentId])} onClick={()=>{
      if(window.confirm(`表示の配送方法で確定しますか？\n${finalOptions.map(t=>`${fbaCarrierName(t)}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`).join('\n')}`))void apply('confirmTransport',{confirmed:true});}}>配送を確定</button>}
   </>}
   </section>}
   </div>
  </div>
  {ready&&<section className="fba-work-box">
   <h4>発送・受領確認</h4>
   <div className="fba-work-actions fba-shipment-actions">
    {act('配送状況確認','refresh',{},false,'primary')}
    <a className="btn" href={sellerCentralShipments} target="_blank" rel="noopener noreferrer">納品一覧</a>
   </div>
   {!work.shipments?.some(s=>s.confirmationId)&&<p>「配送状況確認」を押すと、納品番号と輸送箱が表示されます。</p>}
   {work.shipments?.map((s,i)=>{
    const option=finalOptions.find(t=>t.shipmentId===s.id);
    const self=option?.solution==='USE_YOUR_OWN_CARRIER';
    return <div className="fba-carton" key={s.id}>
     <strong>{s.warehouse||`納品先 ${i+1}`} {s.confirmationId||''}</strong>
     {option&&<p>{fbaCarrierName(option)}/{self?'配送会社と直接精算':option.quote?amount([option.quote]):'見積もりなし'}</p>}
     <p>{shipmentStatus[s.status]??s.status}{s.trackingSaved&&!['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'].includes(s.status)?' ／ 追跡番号送信済み':''}
      {s.received?` ／ 受領 ${Object.values(s.received).reduce((a,b)=>a+b,0)}点`:''}</p>
     {s.boxes?.map((b,j)=><div className="fba-work-actions" key={b.id}><span>箱 {j+1}（{b.skus.map(serial).join('、')}）</span>
      {self&&<label>追跡番号 <input inputMode="text" maxLength={60} disabled={blocked||['CANCELLED','CLOSED','DELETED','ABANDONED'].includes(s.status)} value={tracking[b.id]??b.tracking??''} onChange={e=>setTracking({...tracking,[b.id]:e.target.value})}/></label>}
      {!self&&b.tracking&&<span>追跡番号 {b.tracking}</span>}</div>)}
     {self&&!!s.boxes?.length&&!['CANCELLED','CLOSED','DELETED','ABANDONED'].includes(s.status)&&<button type="button" className="btn" disabled={blocked||!s.boxes.every(b=>tracking[b.id]??b.tracking)} onClick={()=>{
      if(window.confirm('配送会社に引き渡しましたか？　追跡番号をAmazonに送信します。'))void apply('tracking',{shipment:s.id,confirmed:true,tracking:Object.fromEntries(s.boxes!.map(b=>[b.id,tracking[b.id]??b.tracking]))});}}>追跡番号をAmazonに送信</button>}
    </div>;
   })}
  </section>}
  {plan.pending&&<div className="fba-work-actions" role="status"><span>{plan.pending.op?'Amazonの結果を確認中…':'Amazonの受付番号を確認できていません。'}</span>
   {!plan.pending.op&&<button type="button" className="btn" disabled={busy} onClick={()=>void apply('recover')}>処理結果を確認</button>}
   {!!plan.pending.op&&plan.pending.op===failedPoll&&<button type="button" className="btn" disabled={busy} onClick={()=>{setFailedPoll('');setError('');}}>処理結果を再確認</button>}</div>}
  {plan.stage!=='draft'&&(error||work.notice)&&<p className="error" role="alert">{error||work.notice}</p>}
 </section>;
}
