import type { InvoiceReceipt } from '@bussan/shared';
import type { InvoiceLine } from '../../../delivery/src/invoices';
import DateInput from './DateInput';

export interface InvoiceEditDraft {
 issued: string; note: string; lines: InvoiceLine[]; extras: InvoiceLine[]; receipts: InvoiceReceipt[];
}

export default function InvoiceEditor({value,onChange,onSave,onCancel,busy}:{value:InvoiceEditDraft;onChange:(draft:InvoiceEditDraft)=>void;onSave:()=>void;onCancel:()=>void;busy:boolean}) {
 function lineChange(group:'lines'|'extras',index:number,patch:Partial<InvoiceLine>) {
  onChange({...value,[group]:value[group].map((line,i)=>i===index?{...line,...patch}:line)});
 }
 return <form className="invoice-editor" aria-label="請求書の編集" onSubmit={e=>{e.preventDefault();onSave();}}>
 <fieldset disabled={busy}><legend>請求書の編集</legend>
 <label className="field"><span>請求書の日付</span><DateInput required value={value.issued} onChange={e=>onChange({...value,issued:e.target.value})}/></label>
 {(['lines','extras'] as const).flatMap(group=>value[group].map((line,index)=>{
  const label=(group==='lines'?'作業明細':'追加明細')+(index+1);
  return <div className="invoice-editor-row" key={group+index}>
   <label className="field"><span>日付</span><DateInput aria-label={label+'の日付'} value={line.date??''} onChange={e=>lineChange(group,index,{date:e.target.value||null})}/></label>
   <label className="field"><span>明細</span><input aria-label={label+'の明細'} required maxLength={200} value={line.description} onChange={e=>lineChange(group,index,{description:e.target.value})}/></label>
   <label className="field"><span>数量</span><input aria-label={label+'の数量'} type="number" required min={1} max={100000} step={1} value={Number.isFinite(line.quantity)?line.quantity:''} onChange={e=>lineChange(group,index,{quantity:e.target.valueAsNumber})}/></label>
   <label className="field"><span>単価（円）</span><input aria-label={label+'の単価'} type="number" required min={0} max={10000000} step={1} value={Number.isFinite(line.unit_price)?line.unit_price:''} onChange={e=>lineChange(group,index,{unit_price:e.target.valueAsNumber})}/></label>
  </div>;
 }))}
 {value.receipts.map((receipt,index)=>{
  const change=(patch:Partial<InvoiceReceipt>)=>onChange({...value,receipts:value.receipts.map((row,i)=>i===index?{...row,...patch}:row)});
  const label='立替経費'+(index+1);
  return <div className="invoice-editor-row" key={receipt.id}>
   <label className="field"><span>日付</span><DateInput aria-label={label+'の日付'} required value={receipt.spent_on??''} onChange={e=>change({spent_on:e.target.value})}/></label>
   <label className="field"><span>明細</span><input aria-label={label+'の明細'} required maxLength={200} value={receipt.description??''} onChange={e=>change({description:e.target.value})}/></label>
   <label className="field"><span>数量</span><input aria-label={label+'の数量'} value="1" readOnly/></label>
   <label className="field"><span>単価（税込・円）</span><input aria-label={label+'の単価'} type="number" required min={0} max={10000000} step={1} value={Number.isFinite(receipt.amount)?receipt.amount??'':''} onChange={e=>change({amount:e.target.valueAsNumber})}/></label>
  </div>;
 })}
 <label className="field"><span>備考</span><textarea value={value.note} maxLength={2000} onChange={e=>onChange({...value,note:e.target.value})}/></label>
 <div className="toolbar"><button className="btn primary" type="submit">{busy?'保存中…':'保存'}</button><button className="btn" type="button" onClick={onCancel}>キャンセル</button></div>
 </fieldset></form>;
}
