import {
  accessoryDisplayLabel, inventoryBoxColor, inventorySerial, inventorySiteStyle, inventoryStaffStyle,
  inventoryStatusStyle, inventoryStatusText, isSeparateAccessory, jpDate, noticeProductUrl,
  productModelText, salesChannelLabel, staffDisplayName, yen,
} from '@bussan/shared';
import type { ReactNode } from 'react';
import type { InventoryField, InventoryItem } from '../api';
import { inventoryColumns, saleDays, salePayout, salePrice } from '../inventoryFilters';
import AmazonListingPrice from './AmazonListingPrice';
import './inventoryOverview.css';

type Props = {
  items: InventoryItem[];
  canPrice: boolean;
  heading: (field: string) => ReactNode;
  onEdit: (item: InventoryItem, field: InventoryField) => void;
  onFullEdit: (item: InventoryItem) => void;
  onComment: (item: InventoryItem) => void;
};

const groupSerial = (item: InventoryItem) =>
  item.is_accessory && !isSeparateAccessory(item) && item.inventory_parent_serial
    ? item.inventory_parent_serial
    : (item as InventoryItem & { inventory_group_serial?: string }).inventory_group_serial || inventorySerial(item);

function InventoryBand({ title, className = '', children }: { title: string; className?: string; children: ReactNode }) {
  return <section className={'inventory-band ' + className}>
    <h4>{title}</h4>
    <dl>{children}</dl>
  </section>;
}

export default function InventoryOverview({ items, canPrice, heading, onEdit, onFullEdit, onComment }: Props) {
  const parents = new Map(items.filter(item => !item.is_accessory).map(item => [groupSerial(item), item]));
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.is_accessory || isSeparateAccessory(item)) continue;
    const serial = groupSerial(item);
    counts.set(serial, (counts.get(serial) ?? 0) + 1);
  }

  return <section className="approved-inventory" aria-label="在庫一覧">
    <details className="inventory-ledger-filters">
      <summary>項目フィルター</summary>
      <div>{Object.keys(inventoryColumns).map(key => <span key={key}>{heading(key)}</span>)}</div>
    </details>
    {items.map(item => {
      const accessory = item.is_accessory;
      const separate = isSeparateAccessory(item);
      const bundled = accessory && !separate;
      const serial = bundled ? groupSerial(item) : inventorySerial(item);
      const parent = bundled ? parents.get(serial) : undefined;
      const bg = inventoryBoxColor(
        bundled ? parent?.status ?? item.inventory_parent_status ?? item.status : item.status,
        bundled && (parent || item.inventory_parent_serial)
          ? parent ? parent.purchased_at : item.inventory_parent_purchased_at
          : item.purchased_at,
      );
      const saleItem = bundled && !item.product_sale_conflict ? { ...item, sold_on: item.product_sold_on } : item;
      const edit = (key: InventoryField) =>
        onEdit(['sold_on', 'sold_price', 'payout_amount', 'sales_channel'].includes(key) ? saleItem : item, key);
      const button = (key: InventoryField, value: ReactNode, label: string) =>
        <button type="button" className="inventory-cell-edit" onClick={() => edit(key)} title={label + 'を編集'}>{value ?? '—'}</button>;
      const field = (label: string, value: ReactNode, className = '') =>
        <div className={'approved-field ' + className}><dt>{label}</dt><dd>{value}</dd></div>;
      const moneyField = (label: string, value: number | null | undefined, key: InventoryField, className = '') =>
        field(label, button(key, yen(value ?? null), label), className);
      const purchaseUrl = noticeProductUrl(item.marketplace, item.marketplace_item_id, item.marketplace_url);
      const days = saleDays(item);
      const expectedRate = item.planned_price && item.expected_profit != null
        ? (item.expected_profit / item.planned_price * 100).toFixed(1) + '%' : '—';
      const actualRate = item.product_sold_price && item.product_profit != null
        ? (item.product_profit / item.product_sold_price * 100).toFixed(1) + '%' : '—';
      const profitStyle = (value: number | null | undefined) =>
        value == null ? '' : value < 0 ? 'approved-loss' : 'approved-profit';
      const accessoryCount = counts.get(groupSerial(item));
      const badge = accessory ? accessoryDisplayLabel(item) : accessoryCount ? '付属品' + accessoryCount + '点' : '付属品同梱';
      const purchaser = staffDisplayName(item.purchaser_name) || '—';
      const deliverer = staffDisplayName(item.deliverer_name) || '—';
      const channel = salesChannelLabel(item.sales_channel) || '—';
      const showPrice = canPrice && !bundled && item.status === '出品中';

      return <article key={item.id} className="approved-record" aria-label={serial + ' ' + item.title}
        data-item-id={item.id} data-item-status={item.status} data-kind={accessory ? (separate ? 'separate' : 'bundled') : 'body'}
        style={{ backgroundColor: bg }}>
        <header className="approved-identity">
          {!accessory && <button type="button" className="inventory-photo approved-photo" onClick={() => onFullEdit(saleItem)}
            title="商品情報編集" aria-label={item.sku + 'の商品情報編集'}>
            {item.amazon_image_url ? <img src={item.amazon_image_url} alt={item.title + 'の商品画像'} loading="lazy" /> : <span>写真なし</span>}
          </button>}
          <div className="approved-identity-text">
            <div className="approved-serial-line">
              <strong>{button('lot_seq', serial, '通番号')}</strong>
              {accessory ? <button type="button" className="inventory-cell-edit" onClick={() => onFullEdit(saleItem)}
                title="商品情報編集" aria-label={item.sku + 'の商品情報編集'}>
                <span className="inventory-label inventory-accessory-label">{badge}</span>
              </button> : <span className="inventory-label inventory-accessory-label">{badge}</span>}
            </div>
            <div className="approved-model">{accessory ? button('title', item.title, '品名')
              : button(item.model_no ? 'model_no' : 'title', productModelText(item), '型番')}</div>
          </div>
          <span className="inventory-label inventory-status-label" style={inventoryStatusStyle(item.status)}>{inventoryStatusText(item.status)}</span>
        </header>
        <InventoryBand title="商品・担当">
          {!accessory && field('品番', button('product_no', item.product_no, '品番'))}
          {field('SKU', button('sku', item.sku, 'SKU'))}
          {!accessory && field('ASIN', <span className="reference-value">
            {button('asin', item.asin, 'ASIN')}
            {item.asin && <a className="inline-reference-link inventory-inline-link" href={'https://www.amazon.co.jp/dp/' + encodeURIComponent(item.asin)}
              target="_blank" rel="noopener noreferrer" aria-label={item.asin + 'をAmazonで開く'}><span className="external-link-arrow" aria-hidden="true" /></a>}
          </span>)}
          {field('仕入担当者', button('purchaser_id', <span className="inventory-label" style={inventoryStaffStyle(purchaser)}>{purchaser}</span>, '仕入担当者'))}
          {field('納品担当者', button('deliverer_id', <span className="inventory-label" style={inventoryStaffStyle(deliverer)}>{deliverer}</span>, '納品担当者'))}
          {field('登録区分', accessory ? '付属品' : '本体')}
        </InventoryBand>
        <InventoryBand title="仕入">
          {field('仕入先', button('marketplace', <span className="inventory-label" style={inventorySiteStyle(item.marketplace)}>{item.marketplace}</span>, '仕入先'))}
          {field('商品ID', <span className="reference-value">
            {button('marketplace_item_id', item.marketplace_item_id || '—', '商品ID')}
            {purchaseUrl && <a className="inline-reference-link inventory-inline-link" href={purchaseUrl}
              target="_blank" rel="noopener noreferrer" aria-label={item.sku + 'の仕入先の商品ページを開く'}><span className="external-link-arrow" aria-hidden="true" /></a>}
          </span>)}
          {field('追跡番号', button('tracking_no', item.tracking_no || '—', '追跡番号'))}
          {field('仕入日', button('purchased_at', jpDate(item.purchased_at), '仕入日'))}
          {moneyField('仕入金額', item.cost_amount, 'cost_amount')}
        </InventoryBand>
        <InventoryBand title="販売・作業">
          {field('販売先', button('sales_channel', <span className="inventory-label" style={inventorySiteStyle(channel)}>{channel}</span>, '販売先'))}
          {!accessory && field('商品状態', button('condition', item.condition || '—', '商品状態'))}
          {field('作業完了日', button('packed_on', jpDate(item.packed_on), '作業完了日'))}
          {!accessory && <>
            {field('出荷日', button('shipped_on', jpDate(item.shipped_on), '出荷日'))}
            {field('販売日', button('sold_on', item.product_sale_conflict ? '要確認' : jpDate(item.product_sold_on), '販売日'))}
            {field('販売日数', days == null ? '—' : days + '日')}
          </>}
          {showPrice && field('Amazon出品価格（円）', <AmazonListingPrice itemId={item.id} sku={item.sku} salesChannel={item.sales_channel} />, 'inventory-ledger-price')}
        </InventoryBand>
        {!bundled && <>
          <InventoryBand title="予定収支">
            {moneyField('販売予定金額', item.planned_price, 'planned_price')}
            {moneyField('振込予定金額', item.planned_payout, 'planned_payout')}
            {moneyField('予定利益額', item.expected_profit, 'planned_payout', profitStyle(item.expected_profit))}
            {field('予定利益率', expectedRate, profitStyle(item.expected_profit))}
          </InventoryBand>
          <InventoryBand title="確定収支" className={'inventory-ledger-actual ' + profitStyle(item.product_profit)}>
            {moneyField('販売金額', salePrice(item), 'sold_price')}
            {moneyField('振込金額', salePayout(item), 'payout_amount')}
            {moneyField('利益額', item.product_profit, 'payout_amount')}
            {field('利益率', actualRate)}
          </InventoryBand>
        </>}
        {!accessory && <InventoryBand title="返金・補填">
          {moneyField('在庫の払い戻し', item.inventory_refund_amount, 'inventory_refund_amount')}
          {moneyField('Amazon以外からの補填', item.non_amazon_refund_amount, 'non_amazon_refund_amount')}
          {moneyField('Amazon返金金額', item.amazon_refund_amount, 'amazon_refund_amount')}
        </InventoryBand>}
        <dl className="approved-comments">
          {field('仕入担当者からのコメント', <button type="button" className="inventory-comment"
            onClick={() => edit('memo')} title="仕入担当者からのコメントを編集">{item.memo || '—'}</button>)}
          {field('納品担当者からのコメント', item.latest_comment ? <button type="button" className="inventory-comment"
            onClick={() => onComment(item)} title="コメント全文を表示">{item.latest_comment}</button> : '—')}
        </dl>
      </article>;
    })}
  </section>;
}
