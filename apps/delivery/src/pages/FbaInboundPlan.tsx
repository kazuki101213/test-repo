import {useEffect,useState} from 'react';
import DateInput from '../components/DateInput';
import FbaLabelControls from './FbaLabelControls';
import {amount,fbaState,inboundRequest,tokyoDate,type Box,type InboundPlan} from './fbaInboundApi';

const shipmentStatus:Record<string,string>={UNCONFIRMED:'未確定',WORKING:'発送前',READY_TO_SHIP:'発送前',SHIPPED:'発送済み',
 IN_TRANSIT:'配送中',DELIVERED:'到着済み',CHECKED_IN:'到着確認済み',RECEIVING:'受領中',CLOSED:'受領完了',CANCELLED:'取消済み',
 DELETED:'削除済み',ABANDONED:'中止'};
const needWindow=(s:{solution:string;preconditions:string[]})=>s.solution==='USE_YOUR_OWN_CARRIER'||s.preconditions.includes('CONFIRMED_DELIVERY_WINDOW');
const blank=(items:string[]=[]):Box=>({length:0,width:0,height:0,weight:0,items});
const serial=(sku:string)=>sku.split('-')[0]||sku;
const shortDate=(s:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'}).format(new Date(s));
type PrepReview={owners:Record<string,{prepOwner:string;labelOwner:string}>;requirements:Record<string,string[]>};
type PlanResult={plan:InboundPlan;prepReview?:PrepReview};

export default function FbaInboundPlan({plan,onUpdate,onClose}:{plan:InboundPlan;onUpdate:(p:InboundPlan)=>void;onClose:()=>void}){
 const items=plan.fba_inbound_items;
 const work=plan.work;
 const [boxes,setBoxes]=useState<Box[]>(()=>work.boxes??[blank(items.map(i=>i.item_id))]);
 const [dirty,setDirty]=useState(!work.boxes),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [option,setOption]=useState(''),[date,setDate]=useState(work.shipDate??tokyoDate),[selected,setSelected]=useState<Record<string,string>>({});
 const [tracking,setTracking]=useState<Record<string,string>>({}),[windowIds,setWindowIds]=useState<Record<string,string>>({});
 const [pdf,setPdf]=useState<{id:string;url:string}|null>(null);
 const [labelError,setLabelError]=useState('');
 const [prep,setPrep]=useState<PrepReview|null>(null);
 useEffect(()=>()=>{if(pdf)URL.revokeObjectURL(pdf.url);},[pdf]);
 const editable=['draft','created','packing-options','packing-confirmed'].includes(plan.stage);
 const blocked=busy||!!plan.pending;
 const requestBody={id:plan.id,revision:plan.revision};
 const groups=[...new Set(Object.values(work.groups??{}))];

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
   const {plan:next,prepReview}=await inboundRequest<PlanResult>(action,{...requestBody,...fields});
   onUpdate(next);setPrep(prepReview??null);if(action==='saveBoxes'){setBoxes(next.work.boxes??boxes);setDirty(false);}
  }catch(cause){
   setError((cause as Error).message);
   try {onUpdate((await inboundRequest<{plan:InboundPlan}>('get',{id:plan.id})).plan);}catch{/* Keep the current plan open. */}
  }finally{setBusy(false);}
 }
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
 const placement=work.placements?.find(p=>p.id===option)??work.placement;
 const chosen=work.transport?.filter(t=>selected[t.shipmentId]===t.id)??[];
 const finalOptions=work.selections??[];
 const ready=plan.stage==='ready';
 const labelDestinations=ready?work.placement?.shipmentIds??[]:[];
 const sent=work.shipments?.some(s=>s.trackingSaved||['SHIPPED','IN_TRANSIT','DELIVERED','CHECKED_IN','RECEIVING','CLOSED'].includes(s.status));
 const sender=plan.sender;
 return <section className="card fba-workflow" aria-label={plan.name}>
  <div className="fba-selection-group-heading"><div><h3>{plan.name} <span className="inventory-label">{plan.account}</span></h3><span>{fbaState[plan.stage]}</span></div><button type="button" className="btn" onClick={onClose}>閉じる</button></div>
  <div className="fba-work-grid">
   <section className="fba-work-box"><h4>納品商品</h4><ul className="fba-work-items">{items.map(i=><li key={i.item_id}><div><strong className="fba-item-name" title={i.title}>{serial(i.sku)} {i.title}</strong><span>{i.sku} ／ {i.asin}</span></div><span>1点{i.published_at?'・出品中':''}</span></li>)}</ul></section>
   <section className="fba-work-box"><h4>発送元</h4><p>{sender.name}<br/>〒{sender.postalCode}<br/>{sender.stateOrProvinceCode}{sender.city}{sender.addressLine1}{sender.addressLine2}<br/>{sender.phoneNumber}</p>
   <dl className="fba-work-settings"><dt>ワークフロー名</dt><dd>{plan.name}</dd><dt>梱包カテゴリー</dt><dd>{Object.values(work.owners??prep?.owners??{}).some(x=>x.prepOwner==='SELLER')?'Amazon指定の梱包あり':'梱包不要'}</dd>
   <dt>商品のラベル貼付</dt><dd>{Object.values(work.owners??prep?.owners??{}).some(x=>x.labelOwner==='NONE')?'一部ラベル不要':'出品者'}</dd><dt>商品数</dt><dd>{items.length}点（各1点）</dd></dl></section>
  </div>
  <section className="fba-work-box">
   <h4>輸送箱</h4>
   {boxes.map((box,index)=><div className="fba-carton" key={index}>
    <div className="fba-work-actions"><strong>箱 {index+1}</strong>{editable&&boxes.length>1&&<button className="btn" type="button" disabled={blocked} onClick={()=>editBoxes(boxes.filter((_,j)=>index!==j))}>箱を削除</button>}</div>
    <div className="fba-carton-fields">{(['length','width','height','weight'] as const).map((field,i)=><label key={field}>{['長さ (cm)','幅 (cm)','高さ (cm)','重量 (kg)'][i]}<input type="number" min="0.01" step="0.01" inputMode="decimal" disabled={!editable||blocked} value={box[field]||''} onChange={event=>changeBox(index,{[field]:Number(event.target.value)})}/></label>)}</div>
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
    {act('保存','saveBoxes',{boxes},!dirty,'primary')}
   </>}
  </section>
  {!ready&&plan.stage!=='cancelled'&&<section className="fba-work-box">
   <h4>Amazonの納品手続き</h4>
   {plan.stage==='draft'&&<>
    {dirty?<p className="muted">箱情報を保存すると納品プランを作成できます。</p>:<p className="muted">梱包カテゴリーが未設定の商品は、梱包不要として登録します。</p>}
    {prep&&<div role="status"><p>Amazonが指定した梱包・ラベル条件を確認してください。</p>
     {Object.entries(prep.owners).map(([id,owner])=><p key={id}>{serial(items.find(i=>i.item_id===id)?.sku??'')}：{owner.prepOwner==='NONE'?'梱包不要':`出品者が梱包（Amazon指定：${(prep.requirements[id]??[]).join('、')}）`} ／ {owner.labelOwner==='NONE'?'ラベル不要':'出品者がラベル貼付'}</p>)}
    </div>}
    <div className="fba-work-actions"><button type="button" className="btn primary" disabled={blocked||dirty} onClick={()=>{
     if(prep||window.confirm(`${plan.account}に「${plan.name}」を作成しますか？`))void apply('create',{autoPrep:true,acceptPrep:!!prep});
    }}>{prep?'指定条件で納品プランを作成':'Amazonに納品プランを作成'}</button></div>
    {plan.pending?.createAfterPrep&&<p role="status">Amazonに梱包不要を登録しています。反映後に納品プランを作成します。</p>}
    {(error||work.notice)&&<p className="error" role="alert">{error||work.notice}</p>}
   </>}
   {plan.stage==='created'&&act('梱包方法を取得','packing')}
   {plan.stage==='packing-options'&&<>
    {work.packing?.length?<label className="fba-work-field">梱包方法<select disabled={blocked} value={option} onChange={e=>setOption(e.target.value)}><option value="">選択してください</option>
    {work.packing.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.groups.length}グループ ／ {amount(p.fees)}</option>)}</select></label>:<p>Amazonから梱包方法が返されていません。</p>}
    <div className="fba-work-actions"><button className="btn primary" type="button" disabled={blocked||!work.packing?.some(p=>p.id===option)} onClick={()=>{if(window.confirm('表示の梱包方法と料金で確定しますか？'))void apply('choosePacking',{option,confirmed:true});}}>梱包方法を確定</button>{act('梱包方法を再取得','packing')}</div>
   </>}
   {plan.stage==='packing-confirmed'&&act('箱情報をAmazonに送信','boxes',{},dirty,'primary')}
   {plan.stage==='packed'&&act('納品先を取得','placements')}
   {['placement-options','transport-options'].includes(plan.stage)&&<>
    <div className="fba-work-actions">
    <label className="fba-work-field">納品先の候補<select value={placement?.id??''} disabled={blocked} onChange={e=>{setOption(e.target.value);setSelected({});}}><option value="">選択してください</option>
     {work.placements?.map((p,i)=><option key={p.id} value={p.id}>候補 {i+1}：{p.shipmentIds.length}か所 ／ {amount(p.fees)}</option>)}</select></label>
    <label className="fba-work-field">発送予定日<DateInput value={date} onChange={e=>setDate(e.target.value)} disabled={blocked}/></label>
    {act('配送方法を取得','transport',{option:placement?.id,shipDate:date},!placement||!date)}
    {act('納品先を再取得','placements')}</div>
    {plan.stage==='transport-options'&&work.placement&&placement?.id===work.placement.id&&<>
    {work.placement.shipmentIds.map((id,i)=><label className="fba-work-field" key={id}>{work.shipments?.find(s=>s.id===id)?.warehouse||`納品先 ${i+1}`}
     <select value={selected[id]??''} disabled={blocked} onChange={e=>setSelected({...selected,[id]:e.target.value})}><option value="">配送方法を選択</option>
      {work.transport?.filter(t=>t.shipmentId===id).map(t=><option key={t.id} value={t.id}>{t.carrier} ／ {t.solution==='USE_YOUR_OWN_CARRIER'?'配送会社と直接精算':amount(t.quote?[t.quote]:[])}</option>)}
     </select></label>)}
    {!work.transport?.length&&<p>Amazonから利用できる小口配送が返されていません。</p>}
    <button className="btn primary" type="button" disabled={blocked||chosen.length!==work.placement.shipmentIds.length} onClick={()=>{
     if(window.confirm(`納品先を確定しますか？\n納品先の料金：${amount(work.placement?.fees)}\n${chosen.map(t=>`${t.carrier}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`).join('\n')}`))
      void apply('confirmPlacement',{options:chosen.map(t=>t.id),confirmed:true});}}>納品先を確定</button></>}
   </>}
   {plan.stage==='placement-confirmed'&&<>
    {finalOptions.filter(needWindow).map((t,i)=><div className="fba-carton" key={t.shipmentId}>
     <strong>{work.shipments?.find(s=>s.id===t.shipmentId)?.warehouse||`納品先 ${i+1}`}：{t.carrier}</strong>
     {work.selectedWindows?.[t.shipmentId]?<p>到着期間を確定済み</p>:<div className="fba-work-actions">
     {act('到着期間を取得','windows',{shipment:t.shipmentId})}
     {!!work.windows?.[t.shipmentId]?.length&&<><label>到着期間 <select disabled={blocked} value={windowIds[t.shipmentId]??''} onChange={e=>setWindowIds({...windowIds,[t.shipmentId]:e.target.value})}><option value="">選択してください</option>
      {(work.windows?.[t.shipmentId]??[]).map(w=><option key={w.id} value={w.id}>{shortDate(w.start)}〜{shortDate(w.end)}</option>)}</select></label>
      {act('到着期間を確定','chooseWindow',{shipment:t.shipmentId,option:windowIds[t.shipmentId]},!windowIds[t.shipmentId])}</>}
     </div>}
    </div>)}
    <button className="btn primary" type="button" disabled={blocked||finalOptions.some(t=>needWindow(t)&&!work.selectedWindows?.[t.shipmentId])} onClick={()=>{
     if(window.confirm(`表示の配送方法で確定しますか？\n${finalOptions.map(t=>`${t.carrier}：${t.quote?amount([t.quote]):'配送会社と直接精算'}`).join('\n')}`))void apply('confirmTransport',{confirmed:true});}}>配送を確定</button>
   </>}
  </section>}
  {plan.stage!=='cancelled'&&<section className="fba-work-box">
   <h4>配送・ラベル</h4>
   <FbaLabelControls productOnly items={items.filter(i=>!i.published_at&&(work.owners?.[i.item_id]?.labelOwner??'SELLER')==='SELLER').map(i=>({
    id:i.item_id,sku:i.sku,sales_channel:i.sales_channel,
   }))}/>
   <div className="fba-work-actions">
    {labelDestinations.length?labelDestinations.map((id,index)=><button type="button" className="btn" key={id} disabled={blocked} onClick={()=>void label(id)}>配送ラベルを印刷{labelDestinations.length>1?`（${work.shipments?.find(s=>s.id===id)?.warehouse||`納品先 ${index+1}`}）`:''}</button>):<button type="button" className="btn" disabled>配送ラベルを印刷</button>}
    {pdf&&<a className="btn" href={pdf.url} target="_blank" rel="noopener noreferrer">配送ラベルPDFを開いて印刷</a>}
   </div>
   {!labelDestinations.length&&<p className="muted">配送が確定すると、Amazonの配送ラベルを印刷できます。</p>}
   {labelError&&<p className="error" role="alert">{labelError}</p>}
  </section>}
  {ready&&<section className="fba-work-box">
   <h4>発送・受領確認</h4>
   {act('Amazonの状況を確認','refresh',{},false,'primary')}
   {!work.shipments?.some(s=>s.confirmationId)&&<p>Amazonの状況を確認すると、納品番号と輸送箱が表示されます。</p>}
   {work.shipments?.map((s,i)=>{
    const self=finalOptions.find(t=>t.shipmentId===s.id)?.solution==='USE_YOUR_OWN_CARRIER';
    return <div className="fba-carton" key={s.id}>
     <strong>{s.warehouse||`納品先 ${i+1}`} {s.confirmationId||''}</strong>
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
  {!ready&&!sent&&plan.stage!=='cancelled'&&!plan.pending&&<button className="btn" type="button" disabled={busy} onClick={()=>{if(window.confirm('この納品を取り消しますか？'))void apply('cancel');}}>納品を取り消す</button>}
 </section>;
}
