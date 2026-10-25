import { useEffect, useRef, useState, type FormEvent } from 'react';
import { deliveryStaffOptions, staffDisplayName } from '@bussan/shared';
import type { PurchaseDraft, Staff } from '@bussan/shared';
import { registerPurchaseDraftSpare } from '../api';
import DateInput from './DateInput';

export default function PurchaseDraftToSpare({draft,staff,onClose,onRegistered,initialOwnerId='',initialManufacturer,save}:{
  draft:Pick<PurchaseDraft,'id'|'title'|'marketplace'|'marketplace_item_id'|'purchased_at'|'cost_amount'>;
  staff:Staff[];onClose:()=>void;onRegistered:()=>void;initialOwnerId?:string;initialManufacturer?:string;
  save?:(input:Parameters<typeof registerPurchaseDraftSpare>[1])=>Promise<unknown>;
}) {
  const dialog=useRef<HTMLDialogElement>(null),locked=useRef(false);
  const [owner,setOwner]=useState(initialOwnerId);
  const [title,setTitle]=useState(draft.title.includes('リモコン')?'リモコン':draft.title);
  const [manufacturer,setManufacturer]=useState(initialManufacturer??draft.title.match(/SONY|SHARP|Panasonic|TOSHIBA|東芝|パナソニック|ソニー|シャープ/i)?.[0]??'');
  const [date,setDate]=useState(draft.purchased_at||'');
  const [cost,setCost]=useState(draft.cost_amount==null?'':String(draft.cost_amount));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  async function submit(event:FormEvent){
    event.preventDefault();if(locked.current)return;
    if(!owner||!title.trim()||!date||!cost.trim()||!Number.isSafeInteger(Number(cost))||Number(cost)<0){setError('保管担当者・品名・購入日・0円以上の仕入金額を入力してください。');return;}
    locked.current=true;setBusy(true);setError('');
    try{const input={owner_staff_id:owner,title:title.trim(),manufacturer:manufacturer.trim()||null,purchased_at:date,cost_amount:Number(cost)};await(save?save(input):registerPurchaseDraftSpare(draft.id,input));onRegistered();}
    catch(cause){setError((cause as {message?:string})?.message||'予備へ登録できませんでした。');}
    finally{locked.current=false;setBusy(false);}
  }
  return <dialog ref={dialog} className="admin-task-confirmation" aria-label="仕入れリストから予備登録" onCancel={event=>{event.preventDefault();if(!locked.current)onClose();}}>
    <h3>予備登録</h3><p>{draft.title}</p>
    <p>仕入先：{draft.marketplace}<br/>商品ID：{draft.marketplace_item_id}</p>
    <form className="purchase-draft-spare-form" onSubmit={event=>void submit(event)}>
      <label className="field"><span>保管担当者</span><select required value={owner} disabled={busy} onChange={event=>setOwner(event.target.value)}><option value="">選択してください</option>{deliveryStaffOptions(staff).map(person=><option key={person.id} value={person.id}>{staffDisplayName(person)}</option>)}</select></label>
      <label className="field"><span>品名</span><input type="text" required maxLength={500} value={title} disabled={busy} onChange={event=>setTitle(event.target.value)}/></label>
      <label className="field"><span>メーカー</span><input type="text" maxLength={200} value={manufacturer} disabled={busy} onChange={event=>setManufacturer(event.target.value)}/></label>
      <label className="field"><span>購入日</span><DateInput required value={date} disabled={busy} onChange={event=>setDate(event.target.value)}/></label>
      <label className="field"><span>仕入金額</span><input type="number" required min={0} step={1} value={cost} disabled={busy} onChange={event=>setCost(event.target.value)}/></label>
      <p>利用記録は空欄で登録します。</p>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="admin-task-confirmation-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy}>{busy?'登録中…':'予備登録'}</button></div>
    </form>
  </dialog>;
}
