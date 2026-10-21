import { useState } from 'react';
import type { SpareAccessory } from '@bussan/shared';
import { noticeProductUrl } from '@bussan/shared';
import { findInventoryForSpare } from '../api';
import { deliveryAppUrl } from '../appUrls';

const icon = <span aria-hidden="true">↗</span>;

export default function SpareLinks({ row, kind }: { row: SpareAccessory; kind: 'product' | 'usage' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (kind === 'product') {
    const url = noticeProductUrl(row.marketplace, row.marketplace_item_id, null);
    return url ? <a className="inline-reference-link" href={url} target="_blank" rel="noopener noreferrer" aria-label="仕入先の商品ページを開く" title="仕入先の商品ページを開く">{icon}</a> : null;
  }
  const serial = row.usage_note?.trim();
  if (!serial || !/^\d+[a-z]*$/i.test(serial)) return null;
  async function openUsage() {
    if (busy || !serial) return;
    setBusy(true); setError('');
    try {
      const item = await findInventoryForSpare(serial);
      if (!item) throw new Error(`通番号 ${serial} の商品が見つかりません。`);
      const url = new URL(deliveryAppUrl, window.location.href);
      url.searchParams.set('itemId', item.id);
      window.location.assign(url.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '商品を開けませんでした。');
    } finally { setBusy(false); }
  }
  return <><button type="button" className="inline-reference-link" aria-label="利用記録の納品管理商品を開く" title="利用記録の納品管理商品を開く" disabled={busy} onClick={() => void openUsage()}>{icon}</button>{error && <span className="error" role="alert">{error}</span>}</>;
}
