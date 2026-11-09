import {useEffect,useRef,useState} from 'react';
import DateInput from '../components/DateInput';
import FbaLabelControls from './FbaLabelControls';
import {amount,fbaCarrierGroups,fbaCarrierName,inboundRequest,preferredFbaCarrier,tokyoDate,type Box,type InboundPlan} from './fbaInboundApi';

const shipmentStatus:Record<string,string>={UNCONFIRMED:'未確定',WORKING:'発送前',READY_TO_SHIP:'発送前',SHIPPED:'発送済み',
 IN_TRANSIT:'配送中',DELIVERED:'到着済み',CHECKED_IN:'到着確認済み',RECEIVING:'受領中',CLOSED:'受領完了',CANCELLED:'取消済み',
 DELETED:'削除済み',ABANDONED:'中止'};
const needWindow=(s:{solution:string;preconditions:string[]})=>s.solution==='USE_YOUR_OWN_CARRIER'||s.preconditions.includes('CONFIRMED_DELIVERY_WINDOW');
const blank=(items:string[]=[]):Box=>({length:0,width:0,height:0,weight:0,items});
const serial=(sku:string)=>sku.split('-')[0]||sku;
const shortDate=(s:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'}).format(new Date(s));
const sellerCentralShipments='https://sellercentral.amazon.co.jp/gp/ssof/shipping-queue.html';
type PrepReview={owners:Record<string,{prepOwner:string;labelOwner:string}>;requirements:Record<string,string[]>};
type PlanResult={plan:InboundPlan;prepReview?:PrepReview};

export default function FbaInboundPlan({plan,onUpdate,onClose}:{plan:InboundPlan;onUpdate:(p:InboundPlan)=>void;onClose:()=>void}){
 const items=plan.fba_inbound_items;
 const work=plan.work;
 const [boxes,setBoxes]=useState<Box[]>(()=>work.boxes??[blank(items.map(i=>i.item_id))]);
 const [dirty,setDirty]=useState(!work.boxes),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [option,setOption]=useState(''),[date,setDate]=useState(()=>work.shipDate||tokyoDate(3)),[selected,setSelected]=useState<Record<string,string>>({});
 const [tracking,setTracking]=useState<Record<string,string>>({}),[windowIds,setWindowIds]=useState<Record<string,string>>({});
 const [pdf,setPdf]=useState<{id:string;url:string}|null>(null);
 const [labelShipmentId,setLabelShipmentId]=useState('');
 const [labelError,setLabelError]=useState('');
 const [prep,setPrep]=useState<PrepReview|null>(null);
 const automaticAttempt=useRef('');
 useEffect(()=>()=>{if(pdf)URL.revokeObjectURL(pdf.url);},[pdf]);
 const editable=['draft','created','packing-options','packing-confirmed'].includes(plan.stage);
 const canSendBoxes=plan.stage==='packing-confirmed';
 const blocked=busy||!!plan.pending;
 const requestBody={id:plan.id,revision:plan.revision};
 const groups=[...new Set(Object.values(work.groups??{}))];
 const packing=(work.packing??[]).filter(p=>!p.expiration||Date.parse(p.expiration)>Date.now());
 const singlePacking=packing.length===1?packing[0]:undefined;
 const packingChoice=singlePacking??packing.find(p=>p.id===option);
 const autoPackingId=plan.stage==='packing-options'&&singlePacking?.fees.every(fee=>fee.amount===0)?singlePacking.id:undefined;
 const autoPlacements=plan.stage==='packed';

 useEffect(()=>{
  if(!plan.pending?.op)return;
  let active=true;let timer:ReturnType<typeof setTimeout>;
  const run=()=>{timer=setTimeout(async()=>{
   try{const {plan:next,prepReview}=await inboundRequest<PlanResult>('poll',{id:plan.id});
    if(active){onUpdate(next);setPrep(prepReview??null);setError('');if(next.pending?.op===plan.pending?.op)run();}
   }catch(cause){if(active)setError(String((cause as Error).message));}
  },2500);};
  run();
  return()=>{active=false;clearTimeout(timer);};
 },[plan.id,plan.pending?.op]);

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
   onUpdate(next);setPrep(prepReview??null);if(action==='saveBoxes'||action==='boxes'){setBoxes(next.work.boxes??boxes);setDirty(false);}
  }catch(cause){
   setError((cause as Error).message);
   try {onUpdate((await inboundRequest<{plan:InboundPlan}>('get',{id:plan.id})).plan);}catch{/* Keep the current plan open. */}
  }finally{setBusy(false);}
 }
 useEffect(()=>{
  if((!autoPackingId&&!autoPlacements)||blocked||(autoPackingId&&dirty)||error||work.notice)return;
  const attempt=`${plan.revision}:${autoPackingId??'placements'}`;
  if(automaticAttempt.current===attempt)return;
  automaticAttempt.current=attempt;
  if(autoPackingId)void apply('choosePacking',{option:autoPackingId,automatic:true});
  else void apply('placements');
 },[autoPackingId,autoPlacements,blocked,dirty,error,work.notice,plan.revision]);
 async function label(shipment:string,box?:string){
  setBusy(true);setLabelError('');setPdf(null);
  try{const response=await inboundRequest<Blob>('label',{...requestBody,shipment,box});
   setPdf({id:box??shipment,url:URL.createObjectURL(new Blob([response],{type:"application/pdf"}))});}catch(cause){setLabelError((cause as Error).message);}finally{setBusy(false);}
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
 const validDate=/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=today;
 const showCarriers=plan.stage==='transport-options'&&placement?.id===work.placement?.id&&date===work.shipDate&&validDate;
 const carrierRows=showCarriers?(placement?.shipmentIds??[]).map(id=>{
  const options=(work.transport??[]).filter(t=>t.shipmentId===id&&(!t.expiration||Date.parse(t.expiration)>Date.now())
   &&(t.solution!=='AMAZON_PARTNERED_CARRIER'||t.quote)
   &&t.preconditions.every(key=>key==='CONFIRMED_DELIVERY_WINDOW'||key==='CONFIRMED_PLACEMENT_REQUIRED'));
  const choice=selected[id]===undefined?preferredFbaCarrier(options):options.find(t=>t.id===selected[id]);
  return {id,options,choice};
 }):[];
 const chosen=carrierRows.flatMap(row=>row.choice?[row.choice]:[]);
 const finalOptions=work.selections??[];
 const ready=plan.stage==='ready';
 const labelDestinations=ready?work.placement?.shipmentIds??[]:[];
 const labelDestination=labelDestinations.includes(labelShipmentId)?labelShipmentId:labelDestinations[0];
 const sent=work.shipments?.some(s=>s.trackingSaved||['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'].includes(s.status));
 const canCancel=!ready&&!sent&&plan.stage!=='cancelled'&&!plan.pending;
 const sender=plan.sender;
 return <section className="card fba-workflow" aria-label={plan.name}>
  <div className="fba-selection-group-heading">
   <h3>{plan.name} <span className="inventory-label">{plan.account}</span></h3>
   <div className="fba-work-header-actions">
    {canCancel&&<button className="btn" type="button" disabled={busy} onClick={()=>{if(window.confirm('この納品を取り消しますか？'))void apply('cancel');}}>納品取消</button>}
    <button type="button" className="btn" onClick={onClose}>閉じる</button>
   </div>
  </div>
  <div className="fba-work-grid">
   <section className="fba-work-box"><h4>納品商品</h4><ul className="fba-work-items">{items.map(i=><li key={i.item_id}><div><strong className="fba-item-name" title={i.title}>{serial(i.sku)} {i.title}</strong><span>{i.sku} ／ {i.asin}</span></div><span>1点{i.published_at?'・出品中':''}</span></li>)}</ul></section>
   <div className="fba-work-shipping">
   <section className="fba-work-box"><h4>発送元</h4><p>{sender.name}<br/>〒{sender.postalCode}<br/>{sender.stateOrProvinceCode}{sender.city}{sender.addressLine1}{sender.addressLine2}<br/>{sender.phoneNumber}</p>
   <dl className="fba-work-settings">
    <dt>ワークフロー名</dt><dd>{plan.name}</dd>
    <dt>商品数</dt><dd>{items.length}点（各1点）</dd>
    {plan.amazon_id&&<><dt>Amazon納品プランID</dt><dd>{plan.amazon_id}</dd></>}
   </dl></section>
  <section className="fba-work-box">
   <h4>輸送箱</h4>
   {boxes.map((box,index)=><div className="fba-carton" key={index}>
    <div className="fba-work-actions"><strong>箱 {index+1}</strong>{editable&&boxes.length>1&&<button className="btn" type="button" disabled={blocked} onClick={()=>editBoxes(boxes.filter((_,j)=>index!==j))}>箱を削除</button>}</div>
    <div className="fba-carton-fields">{(['length','width','height','weight'] as const).map((field,i)=><label key={field}>{['長さ (cm)','幅 (cm)','高さ (cm)','重量 (kg)'][i]}<input type="number" min="0.01" step="0.01" inputMode="decimal" disabled={!editable||blocked} value={box[field]||''} style={{width:`calc(${String(box[field]||'').length}ch + 32px)`}} onChange={event=>changeBox(index,{[field]:Number(event.target.value)})}/></label>)}</div>
    {!editable&&<p>{box.items.map(id=>serial(items.find(i=>i.item_id===id)?.sku??'')).join('、')}</p>}
   </div>)}
   {editable&&<>
    <div className="fba-work-actions"><button type="button" className="btn" disabled={blocked||boxes.length>=items.length} onClick={()=>editBoxes([...boxes,blank()])}>追加</button></div>
    <ul className="fba-work-items fba-box-assignments">{items.map(item=><li key={item.item_id}>
     <label htmlFor={'box-'+item.item_id}>
      <span className="fba-item-name" title={item.title}>{serial(item.sku)} {item.title}</span>
      {groups.length>1&&<small>梱包グループ {groups.indexOf(work.groups?.[item.item_id]??'')+1}</small>}
     </label>
     <select id={'box-'+item.item_id} disabled={blocked} value={boxes.findIndex(b=>b.items.includes(item.item_id))} onChange={e=>assign(item.item_id,Number(e.target.value))}><option value="-1">未割当</option>{boxes.map((_,i)=><option key={i} value={i}>箱 {i+1}</option>)}</select>
    </li>)}</ul>
    {canSendBoxes?act('送信','boxes',{boxes},false,'primary'):plan.stage!=='draft'&&act('保存','saveBoxes',{boxes},!dirty,'primary')}
   </>}
  </section>
   </div>
  </div>
  {!ready&&plan.stage!=='cancelled'&&!canSendBoxes&&<section className="fba-work-box">
   <h4>Amazonの納品手続き</h4>
   {plan.stage==='draft'&&<>
    {prep&&<div role="status"><p>Amazonが指定した梱包・ラベル条件を確認してください。</p>
     {Object.entries(prep.owners).map(([id,owner])=>{
      const requirements=prep.requirements[id]??[];
      const labelOnly=requirements[0]==='NONE'&&requirements.includes('ITEM_LABELING')&&requirements.every(type=>['NONE','ITEM_LABELING','ITEM_NO_PREP'].includes(type));
      return <p key={id}>{serial(items.find(i=>i.item_id===id)?.sku??'')}：{owner.prepOwner==='NONE'||labelOnly?'梱包不要':`出品者が梱包（Amazon指定：${requirements.join('、')}）`} ／ {owner.labelOwner==='NONE'?'ラベル不要':'出品者がラベル貼付'}</p>;
     })}
    </div>}
    <div className="fba-work-actions"><button type="button" className="btn primary" disabled={blocked} onClick={()=>{
     if(prep||window.confirm(`${plan.account}に「${plan.name}」を作成しますか？`))void apply('create',{autoPrep:true,acceptPrep:!!prep});
    }}>{prep?'指定条件で納品プランを作成':'Amazonに納品プランを作成'}</button></div>
    {plan.pending?.createAfterPrep&&<p role="status">Amazonに梱包不要を登録しています。反映後に納品プランを作成します。</p>}
    {(error||work.notice)&&<p className="error" role="alert">{error||work.notice}</p>}
   </>}
   {plan.stage==='created'&&act('梱包方法を取得','packing')}
   {plan.stage==='packing-options'&&(autoPackingId&&!error&&!work.notice
    ? <p role="status">{dirty?'箱情報を保存すると、梱包方法が自動で確定します。':'料金のかからない梱包方法を自動で確定しています…'}</p>
    : <>
     {singlePacking&&!autoPackingId&&<p>梱包方法　{singlePacking.groups.length}グループ ／ {amount(singlePacking.fees)}</p>}
     {packing.length>1&&<label className="fba-work-field">梱包方法<select aria-label="梱包方法" disabled={blocked} value={packingChoice?.id??''} onChange={e=>setOption(e.target.value)}><option value="">選択してください</option>
     {packing.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.groups.length}グループ ／ {amount(p.fees)}</option>)}</select></label>}
     {!packing.length&&<p>選択できる梱包方法がありません。</p>}
     <div className="fba-work-actions">
      {!autoPackingId&&packing.length>0&&<button className="btn primary" type="button" disabled={blocked||!packingChoice} onClick={()=>{if(packingChoice&&window.confirm('表示の梱包方法と料金で確定しますか？'))void apply('choosePacking',{option:packingChoice.id,confirmed:true});}}>梱包方法を確定</button>}
      {act('梱包方法を再取得','packing')}
     </div>
    </>)}
   {autoPlacements&&(error||work.notice?act('再取得','placements'):<p role="status">納品先の候補を取得しています…</p>)}
   {['placement-options','transport-options'].includes(plan.stage)&&<>
    <div className="fba-work-actions fba-transport-actions">
    <label className="fba-work-field">納品先の候補<select aria-label="納品先の候補" value={placement?.id??''} disabled={blocked||!placements.length} onChange={e=>{setOption(e.target.value);setSelected({});}}>
     {placements.length!==1&&<option value="" disabled>選択してください</option>}
     {placements.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.shipmentIds.length}か所 ／ {amount(p.fees)}</option>)}</select></label>
    <label className="fba-work-field">出荷日<DateInput aria-label="出荷日" value={date} min={today} onChange={e=>{setDate(e.target.value);setSelected({});}} disabled={blocked}/></label>
    <label className="fba-work-field">配送モード<select aria-label="配送モード" value="SPD" disabled><option value="SPD">個口配送（SPD）</option></select></label>
    {act('取得','transport',{option:placement?.id,shipDate:date},!placement||!validDate,'primary')}
    {act('再取得','placements')}</div>
    {showCarriers&&carrierRows.length>0&&<>
    <p className="muted">Amazonの配送料見積もり（{items.length}点、{work.boxes?.length??boxes.length}箱、出荷日 {work.shipDate}）</p>
    <p className="muted">同じ納品をセラーセントラルで照合する場合は、配送確定後に納品番号を確認してください。確定前に切り替えると、Amazonが配送候補を作り直します。</p>
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
     if(window.confirm(`納品先を確定しますか？\n出荷日：${date}\n納品先の料金：${amount(work.placement?.fees)}\n${chosen.map(t=>`${fbaCarrierName(t)}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`).join('\n')}`))
      void apply('confirmPlacement',{options:chosen.map(t=>t.id),confirmed:true});}}>納品先を確定</button></>}
   </>}
   {plan.stage==='placement-confirmed'&&<>
    {finalOptions.filter(needWindow).map((t,i)=><div className="fba-carton" key={t.shipmentId}>
     <strong>{work.shipments?.find(s=>s.id===t.shipmentId)?.warehouse||`納品先 ${i+1}`}：{fbaCarrierName(t)}</strong>
     {work.selectedWindows?.[t.shipmentId]?<p>到着期間を確定済み</p>:<div className="fba-work-actions">
     {act('到着期間を取得','windows',{shipment:t.shipmentId})}
     {!!work.windows?.[t.shipmentId]?.length&&<><label>到着期間 <select disabled={blocked} value={windowIds[t.shipmentId]??''} onChange={e=>setWindowIds({...windowIds,[t.shipmentId]:e.target.value})}><option value="">選択してください</option>
      {(work.windows?.[t.shipmentId]??[]).map(w=><option key={w.id} value={w.id}>{shortDate(w.start)}〜{shortDate(w.end)}</option>)}</select></label>
      {act('到着期間を確定','chooseWindow',{shipment:t.shipmentId,option:windowIds[t.shipmentId]},!windowIds[t.shipmentId])}</>}
     </div>}
    </div>)}
    <button className="btn primary" type="button" disabled={blocked||finalOptions.some(t=>needWindow(t)&&!work.selectedWindows?.[t.shipmentId])} onClick={()=>{
     if(window.confirm(`表示の配送方法で確定しますか？\n${finalOptions.map(t=>`${fbaCarrierName(t)}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`).join('\n')}`))void apply('confirmTransport',{confirmed:true});}}>配送を確定</button>
   </>}
  </section>}
  {plan.stage!=='cancelled'&&<section className="fba-work-box">
   <h4>配送ラベル、納品ラベル</h4>
   {labelDestinations.length>1&&<label className="fba-work-field fba-label-destination">納品先<select aria-label="納品先" value={labelDestination} disabled={blocked} onChange={event=>{setLabelShipmentId(event.target.value);setPdf(null);setLabelError('');}}>
    {labelDestinations.map((id,index)=><option value={id} key={id}>{work.shipments?.find(s=>s.id===id)?.warehouse||`納品先 ${index+1}`}</option>)}
   </select></label>}
   <FbaLabelControls productOnly shippingLabel={<button type="button" className="btn primary" disabled={blocked||!labelDestination} onClick={()=>{if(labelDestination)void label(labelDestination);}}>配送ラベル</button>}
    items={items.filter(i=>!i.published_at&&(work.owners?.[i.item_id]?.labelOwner??'SELLER')==='SELLER').map(i=>({
    id:i.item_id,sku:i.sku,sales_channel:i.sales_channel,
   }))}/>
   {pdf&&<div className="fba-work-actions"><a className="btn" href={pdf.url} target="_blank" rel="noopener noreferrer">配送ラベルPDFを開いて印刷</a></div>}
   {labelError&&<p className="error" role="alert">{labelError}</p>}
  </section>}
  {ready&&<section className="fba-work-box">
   <h4>発送・受領確認</h4>
   <div className="fba-work-actions">
    {act('Amazonの状況を確認','refresh',{},false,'primary')}
    <a className="btn" href={sellerCentralShipments} target="_blank" rel="noopener noreferrer">セラーセントラルの納品一覧</a>
   </div>
   {!work.shipments?.some(s=>s.confirmationId)&&<p>Amazonの状況を確認すると、納品番号と輸送箱が表示されます。</p>}
   {work.shipments?.map((s,i)=>{
    const option=finalOptions.find(t=>t.shipmentId===s.id);
    const self=option?.solution==='USE_YOUR_OWN_CARRIER';
    return <div className="fba-carton" key={s.id}>
     <strong>{s.warehouse||`納品先 ${i+1}`} {s.confirmationId||''}</strong>
     {option&&<p>配送業者 {fbaCarrierName(option)} ／ {self?'配送会社と直接精算':option.quote?`Amazonの配送料見積もり ${amount([option.quote])}`:'見積もりなし'}</p>}
     <p>{shipmentStatus[s.status]??s.status}{s.trackingSaved&&!['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'].includes(s.status)?' ／ 追跡番号送信済み':''}
      {s.received?` ／ 受領 ${Object.values(s.received).reduce((a,b)=>a+b,0)}点`:''}</p>
     {s.boxes?.map((b,j)=><div className="fba-work-actions" key={b.id}><span>箱 {j+1}（{b.skus.map(serial).join('、')}）</span>
      {self&&<label>追跡番号 <input inputMode="text" maxLength={60} disabled={blocked||['CANCELLED','CLOSED','DELETED','ABANDONED'].includes(s.status)} value={tracking[b.id]??b.tracking??''} onChange={e=>setTracking({...tracking,[b.id]:e.target.value})}/></label>}
      {!self&&b.tracking&&<span>追跡番号 {b.tracking}</span>}
      <button className="btn" type="button" disabled={blocked} onClick={()=>void label(s.id,b.id)}>この箱のラベル</button></div>)}
     {self&&!!s.boxes?.length&&!['CANCELLED','CLOSED','DELETED','ABANDONED'].includes(s.status)&&<button type="button" className="btn" disabled={blocked||!s.boxes.every(b=>tracking[b.id]??b.tracking)} onClick={()=>{
      if(window.confirm('配送会社に引き渡しましたか？　追跡番号をAmazonに送信します。'))void apply('tracking',{shipment:s.id,confirmed:true,tracking:Object.fromEntries(s.boxes!.map(b=>[b.id,tracking[b.id]??b.tracking]))});}}>追跡番号をAmazonに送信</button>}
    </div>;
   })}
  </section>}
  {plan.pending&&<div className="fba-work-actions" role="status"><span>{plan.pending.op?'Amazonの結果を確認中…':'Amazonの受付番号を確認できていません。'}</span>
   <button type="button" className="btn" disabled={busy} onClick={()=>void apply(plan.pending?.op?'poll':'recover')}>処理結果を確認</button></div>}
  {plan.stage!=='draft'&&(error||work.notice)&&<p className="error" role="alert">{error||work.notice}</p>}
 </section>;
}
