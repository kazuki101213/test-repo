import {useEffect,useState} from 'react';
import {canViewDeliveryAssignee,inventorySerial,inventorySiteStyle,productModelText,staffDisplayName} from '@bussan/shared';
import type {DeliveryTask,Staff} from '@bussan/shared';
import {fetchTask} from '../api';
import {canSelectFbaItem,fbaSelectionAccount} from '../fbaSelection';
import {deliveryErrorMessage} from '../errors';
import './fbaDelivery.css';

export default function FbaDelivery({staff,itemIds,onSelectionChange,onBack}:{staff:Staff;itemIds:string[];onSelectionChange:(ids:string[])=>void;onBack:()=>void}) {
 const [rows,setRows]=useState<DeliveryTask[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const selectionKey=JSON.stringify(itemIds);
 useEffect(()=>{
  let active=true;const ids:string[]=JSON.parse(selectionKey);
  setRows([]);setError('');setLoading(!!ids.length);
  if(!ids.length)return()=>{active=false;};
  void Promise.allSettled(ids.map(id=>fetchTask(id,canViewDeliveryAssignee(staff)))).then(results=>{
   if(!active)return;
   const available=results.flatMap(result=>result.status==='fulfilled'&&result.value&&canSelectFbaItem(result.value,staff)?[result.value]:[]);
   setRows(available);setLoading(false);
   if(available.length!==ids.length)setError('状態または担当者が変更された商品があります。在庫に戻って選択し直してください。');
  }).catch(cause=>{if(active){setLoading(false);setError(deliveryErrorMessage(cause));}});
  return()=>{active=false;};
 },[selectionKey,staff.id,staff.role]);

 return <section className="fba-delivery" aria-labelledby="fba-delivery-heading">
  <div className="fba-delivery-heading"><h2 id="fba-delivery-heading">FBA納品</h2><button type="button" className="btn ghost" onClick={onBack}>在庫に戻る</button></div>
  <p className="muted">選択した商品をアカウントごとに確認できます。Amazonへの納品プランは未作成です。</p>
  {loading&&<p role="status">選択商品を確認中…</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {!loading&&!itemIds.length&&<p className="empty">在庫で納品する商品にチェックを入れてください。</p>}
  {(['FBA1','FBA2'] as const).map(account=>{
   const items=rows.filter(item=>fbaSelectionAccount(item)===account);if(!items.length)return null;
   return <section key={account} className="card fba-selection-group" aria-label={`${account}の納品商品`}>
    <div className="fba-selection-group-heading"><h3><span className="inventory-label" style={inventorySiteStyle(account)}>{account}</span></h3><span>{items.length}商品・{items.length}点</span></div>
    <div className="fba-selection-head" aria-hidden="true"><span>通番号・商品 / SKU</span><span>納品担当者</span><span>数量</span><span/></div>
    {items.map(item=><article key={item.id} className="fba-selection-item">
     <div className="fba-selection-identity">{item.reference_image_url&&<img src={item.reference_image_url} alt="" loading="lazy"/>}<div><div><strong>{inventorySerial(item)}</strong> <b>{productModelText(item)}</b></div><span>{item.asin}</span><p>{item.sku}</p><span>{item.condition}</span></div></div>
     <span className="fba-selection-assignee">{staffDisplayName(item.deliverer_name)||'未設定'}</span><span className="fba-selection-quantity">1点</span>
     <button type="button" className="fba-remove-item" aria-label={`${inventorySerial(item)}を選択から外す`} onClick={()=>onSelectionChange(itemIds.filter(id=>id!==item.id))}>×</button>
    </article>)}
   </section>;
  })}
 </section>;
}
