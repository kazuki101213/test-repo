import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';
interface Packed { id:string; lot_seq:number; purchased_at:string; packed_on:string; title:string; sku:string }
export default function PackedSummary({ staffId, initialMonth, billedCount }: { staffId:string; initialMonth?:string; billedCount?:number }) {
 const [month,setMonth]=useState(initialMonth ?? new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit'}).format(new Date()));
 const [all,setAll]=useState(true);
 const [rows,setRows]=useState<Packed[]>([]);
 const [error,setError]=useState('');
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  let active=true; setLoading(true); setError(''); setRows([]);
  void (async()=>{
   const {data,error}=await getSupabase().rpc('packed_product_summary',{p_staff:staffId,p_month:all?null:month+'-01'});
   if(error)throw error; if(active)setRows(data as Packed[]);
  })().catch(e=>{if(active)setError(e.message??String(e));}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[staffId,month,all]);
 const compare=billedCount!==undefined&&!all&&month===initialMonth;
 return <section className="packed-summary no-print"><h3>納品実績</h3>
 <div className="row toolbar"><label>梱包した月 <input type="month" value={month} disabled={all} onChange={e=>{if(e.target.value)setMonth(e.target.value);}}/></label>
 <label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/> 全期間</label></div>
 {error&&<p className="error" role="alert">{error}</p>}
 {loading?<p>読み込み中…</p>:!error&&<><p><strong>納品 {rows.length} 点</strong>{compare&&<span> ／ 請求書 {billedCount} 点　{billedCount===rows.length?'一致':'差があります'}</span>}</p>
 <div style={{overflow:'auto',maxHeight:'45vh'}}><table style={{width:'100%'}}><thead><tr><th>通番号</th><th>購入日</th><th>梱包日</th><th>SKU</th><th>商品名</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.lot_seq}</td><td>{row.purchased_at?.slice(0,10)??'—'}</td><td>{row.packed_on?.slice(0,10)}</td><td>{row.sku}</td><td>{row.title}</td></tr>)}</tbody></table>{!rows.length&&<p>該当する商品はありません。</p>}</div></>}
 </section>;
}
