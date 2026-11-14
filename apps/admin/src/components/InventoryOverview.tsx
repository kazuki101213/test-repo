import { salesChannelLabel } from '@bussan/shared';
import type { ReactNode } from 'react';
import { inventoryBoxColor, inventoryStaffStyle, inventorySiteStyle, inventoryStatusStyle, inventoryStatusText, inventorySerial, isSeparateAccessory, accessoryDisplayLabel, productModelText, staffDisplayName, noticeProductUrl, jpDate, yen } from '@bussan/shared';
import type { InventoryItem, InventoryField } from '../api';
import { saleDays, salePayout, salePrice } from '../inventoryFilters';
import AmazonListingPrice from './AmazonListingPrice';
import InventoryPhotos from './InventoryPhotos';
import './inventoryOverview.css';

type Props={items:InventoryItem[];canPrice:boolean;openPhotosFor:string|null;heading:(field:string)=>ReactNode;onEdit:(item:InventoryItem,field:InventoryField)=>void;onFullEdit:(item:InventoryItem)=>void;onComment:(item:InventoryItem)=>void;onTogglePhotos:(itemId:string)=>void};
export default function InventoryOverview({items,canPrice,openPhotosFor,heading,onEdit,onFullEdit,onComment,onTogglePhotos}:Props){
 const serialOf=(i:InventoryItem)=>i.is_accessory&&!isSeparateAccessory(i)&&i.inventory_parent_serial?i.inventory_parent_serial:(i as InventoryItem&{inventory_group_serial?:string}).inventory_group_serial||inventorySerial(i);
 const parents=new Map(items.filter(i=>!i.is_accessory).map(i=>[serialOf(i),i]));
 const counts=new Map<string,number>();for(const i of items)if(i.is_accessory&&!isSeparateAccessory(i))counts.set(serialOf(i),(counts.get(serialOf(i))??0)+1);
 const headers=[['status','photo','serial','product_no','model','sku','asin','registration'],['purchaser','deliverer','marketplace','sales_channel'],['item_id','tracking','purchased_at','cost'],['condition','packed_on','shipped_on','sold_on','sold_days'],[],['planned_price','planned_payout','sold_price','payout'],['expected_profit','expected_rate','profit','rate'],['inventory_refund','other_refund','amazon_refund'],['purchaser_comment','comment']];
 return <div className="approved-inventory" role="table" aria-label="在庫" aria-rowcount={items.length+1}>
  <div className="approved-inventory-head approved-inventory-row" role="row">{headers.map((keys,n)=><div role="columnheader" key={n}>{n===4?'Amazon出品価格（円）':n===0?[['status'],['photo','serial','product_no'],['model'],['sku'],['asin','registration']].map((line,index)=><div className="approved-heading-line" key={index}>{line.map(k=><span key={k}>{heading(k)}</span>)}</div>):keys.map(k=><div key={k}>{heading(k)}</div>)}</div>)}</div>
  {items.map(i=>{
   const separate=isSeparateAccessory(i),accessory=i.is_accessory,parent=accessory&&!separate?parents.get(serialOf(i)):undefined;
   const saleItem=accessory&&!separate&&!i.product_sale_conflict?{...i,sold_on:i.product_sold_on}:i;
   const edit=(field:InventoryField)=>onEdit(['sold_on','sold_price','payout_amount','sales_channel'].includes(field)?saleItem:i,field);
   const inherits=accessory&&!separate;
   const statusLabel = inventoryStatusText(i.status);
   const statusStyle = inventoryStatusStyle(i.status);
   const status = inherits
     ? <span className="inventory-label inventory-status-label" style={statusStyle}>{statusLabel}</span>
     : <button type="button" className="inventory-label inventory-status-label approved-status-edit" style={statusStyle}
         aria-label={`${i.sku}の販売状態を編集（${statusLabel}）`} title="販売状態を編集" onClick={()=>edit('status')}>{statusLabel}</button>;
   const photosOpen = openPhotosFor === i.id;
   const photosId = `inventory-photos-${i.id}`;
   const photoToggle = (placement: 'mobile' | 'desktop') => (
     <button type="button" className={`btn ghost approved-photo-toggle approved-photo-toggle-${placement}`} aria-expanded={photosOpen}
       aria-controls={photosOpen ? photosId : undefined} onClick={()=>onTogglePhotos(i.id)}>
       {photosOpen ? '写真を閉じる' : '写真確認'}
     </button>
   );
   const statusActions = <span className="approved-status-actions">{status}{photoToggle('mobile')}</span>;
   const bg=inventoryBoxColor(inherits?(parent?.status??i.inventory_parent_status??i.status):i.status,inherits&&(parent||i.inventory_parent_serial)?(parent?parent.purchased_at:i.inventory_parent_purchased_at):i.purchased_at),serial=inherits?serialOf(i):inventorySerial(i);
   const purchaseUrl=noticeProductUrl(i.marketplace,i.marketplace_item_id,i.marketplace_url),actual=salePrice(i),payout=salePayout(i),rate=i.product_sold_price&&i.product_profit!=null?(i.product_profit/i.product_sold_price*100).toFixed(1)+'%':'—',expectedRate=i.planned_price&&i.expected_profit!=null?(i.expected_profit/i.planned_price*100).toFixed(1)+'%':'—';
   const button=(field:InventoryField,value:ReactNode,className='')=><button type="button" className={`inventory-cell-edit ${className}`} onClick={()=>edit(field)} title={`${({marketplace_item_id:'商品ID',tracking_no:'追跡番号',asin:'ASIN',memo:'仕入担当者からのコメント'} as Record<string,string>)[field]??'項目'}をクリックして編集`}>{value??'—'}</button>;
   const field=(label:string,value:ReactNode,cls='')=><div className={`approved-field ${cls}`}><span className="approved-field-label">{label}</span><span className="approved-field-value">{value}</span></div>;
   const moneyField=(label:string,value:number|null|undefined,key:InventoryField)=>field(label,button(key,yen(value??null)));
   const badge=accessory?accessoryDisplayLabel(i):(counts.get(serialOf(i))?'付属品'+counts.get(serialOf(i))+'点':'付属品同梱');
   const profitClass=(n:number|null|undefined)=>n!=null&&n<0?'approved-loss':'approved-profit';
   return <div key={i.id} className={`approved-inventory-row approved-record${accessory?' approved-accessory':''}${separate?' approved-separate':''}`} role="row" data-item-id={i.id} data-item-status={i.status} data-kind={accessory?(separate?'separate':'bundled'):'body'} style={{backgroundColor:bg}}>
    <div className="approved-identity" role="cell">
     {accessory?<span className="approved-child-state">{statusActions}</span>:<button type="button" className="inventory-photo approved-photo" onClick={()=>onFullEdit(saleItem)} title="商品情報編集" aria-label={`${i.sku}の商品情報編集`}>{i.amazon_image_url?<img src={i.amazon_image_url} alt={`${i.title}の商品画像`} loading="lazy"/>:<span>写真なし</span>}</button>}
     <div className="approved-identity-text">
      {!accessory&&statusActions}
      <div className="approved-serial-line"><strong>{button('lot_seq',serial)}</strong>{!accessory&&<span className="approved-product-number"> / {button('product_no',i.product_no??'—')}</span>}{accessory&&button('title',i.title)}{accessory?<button type="button" className="inventory-cell-edit" onClick={()=>onFullEdit(saleItem)} title="商品情報編集" aria-label={`${i.sku}の商品情報編集`}><span className="inventory-label inventory-accessory-label">{badge}</span></button>:<span className="inventory-label inventory-accessory-label">{badge}</span>}</div>
      {!accessory&&<div className="approved-model">{button(i.model_no?'model_no':'title',productModelText(i))}</div>}
      {button('sku',i.sku,'sku approved-sku')}
      {!accessory&&<div className="approved-asin">{button('asin',i.asin??'—')}{i.asin&&<a className="inline-reference-link inventory-inline-link" href={`https://www.amazon.co.jp/dp/${encodeURIComponent(i.asin)}`} target="_blank" rel="noopener noreferrer" aria-label={`${i.asin}をAmazonで開く`}><span className="external-link-arrow" aria-hidden="true" /></a>}<span> / {i.is_accessory?'付属品':'本体'}</span></div>}
     </div>
    </div>
    <div className="approved-people" role="cell">{([['仕入担当者',staffDisplayName(i.purchaser_name)||'—','purchaser_id',true],['納品担当者',staffDisplayName(i.deliverer_name)||'—','deliverer_id',true],['仕入先',i.purchase_account_label||i.marketplace,'marketplace',false],['販売先',i.sales_account_label||salesChannelLabel(i.sales_channel)||'—','sales_channel',false]] as const).map(([label,value,key,person])=><div key={label}><span className="approved-field-label">{label}</span>{button(key,<span className="inventory-label" style={person?inventoryStaffStyle(value):inventorySiteStyle(value)}>{value}</span>)}{key==="sales_channel"&&i.flea_listing_account_label&&<span className="inventory-label" style={inventorySiteStyle(i.flea_listing_account_label)}>{i.flea_listing_account_label}（出品記録）</span>}</div>)}</div>
    <div className="approved-purchase" role="cell">{!accessory&&<div className="approved-mobile-meta">{field('品番',button('product_no',i.product_no??'—'))}{field('ASIN',<span>{button('asin',i.asin||'—')}{i.asin&&<a className="inventory-inline-link" href={`https://www.amazon.co.jp/dp/${encodeURIComponent(i.asin)}`} target="_blank" rel="noopener noreferrer" aria-label={`${i.asin}をAmazonで開く`}><span className="external-link-arrow" aria-hidden="true" /></a>}</span>)}{field('登録区分','本体')}</div>}{field('商品ID',<span className="reference-value">{button('marketplace_item_id',i.marketplace_item_id||'—')}{purchaseUrl&&<a className="inline-reference-link inventory-inline-link" href={purchaseUrl} target="_blank" rel="noopener noreferrer" aria-label={`${i.sku}の仕入先の商品ページを開く`}><span className="external-link-arrow" aria-hidden="true" /></a>}</span>)}{field('追跡番号',button('tracking_no',i.tracking_no||'—','approved-tracking'))}{field('仕入日',button('purchased_at',jpDate(i.purchased_at)))}{moneyField('仕入金額',i.cost_amount,'cost_amount')}</div>
    <div className="approved-dates" role="cell">{!accessory&&field('商品状態',button('condition',i.condition||'—'))}{field('作業完了日',button('packed_on',jpDate(i.packed_on)))}{!accessory&&<>{field('出荷日',button('shipped_on',jpDate(i.shipped_on)))}{field('販売日',button('sold_on',i.product_sale_conflict?'要確認':jpDate(i.product_sold_on)))}{field('販売日数',saleDays(i)==null?'—':saleDays(i)+'日')}</>}</div>
    <div className="approved-amazon-price" role="cell"><span className="approved-field-label">Amazon出品価格（円）</span>{canPrice&&(!accessory||separate)&&i.status==='出品中'?<AmazonListingPrice itemId={i.id} sku={i.sku} salesChannel={i.sales_channel}/>:<span>—</span>}</div>
    <div className="approved-amounts" role="cell">{(!accessory||separate)&&<>{moneyField('販売予定金額',i.planned_price,'planned_price')}{moneyField('振込予定金額',i.planned_payout,'planned_payout')}{moneyField('販売金額',actual,'sold_price')}{moneyField('振込金額',payout,'payout_amount')}</>}</div>
    <div className="approved-profits" role="cell">{(!accessory||separate)&&<><div className={`approved-expected ${profitClass(i.expected_profit)}`}>{moneyField('予定利益額',i.expected_profit,'planned_payout')}{field('予定利益率',expectedRate)}</div><div className={`approved-actual ${profitClass(i.product_profit)}`}>{moneyField('利益額',i.product_profit,'payout_amount')}{field('利益率',rate)}</div></>}</div>
    <div className="approved-refunds" role="cell">{!accessory&&<>{moneyField('在庫の払い戻し',i.inventory_refund_amount,'inventory_refund_amount')}{moneyField('Amazon以外からの補填',i.non_amazon_refund_amount,'non_amazon_refund_amount')}{moneyField('Amazon返金金額',i.amazon_refund_amount,'amazon_refund_amount')}</>}</div>
    <div className="approved-comments" role="cell">
     {field('仕入担当者からのコメント',<button type="button" className="inventory-comment" onClick={()=>edit('memo')} title="仕入担当者からのコメントを編集">{i.memo||'—'}</button>)}
     {field('納品担当者からのコメント',i.latest_comment?<button type="button" className="inventory-comment" onClick={()=>onComment(i)} title="コメント全文を表示">{i.latest_comment}</button>:'—')}
     {photoToggle('desktop')}
    </div>
    {photosOpen && <div className="approved-inventory-photos" role="cell" aria-colspan={9}><InventoryPhotos itemId={i.id} sku={i.sku} id={photosId}/></div>}
   </div>;
  })}
 </div>;
}
