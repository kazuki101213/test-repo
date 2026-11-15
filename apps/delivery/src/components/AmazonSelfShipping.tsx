import { useEffect, useRef, useState } from 'react';
import { getSupabase, inventorySerial, salesChannelLabel, type DeliveryTask } from '@bussan/shared';

type ShippingOrder = { orderId: string; amazonSku: string; shipBy: string | null; account: 'amazon-1' | 'amazon-2' };
const sellerCentral = 'https://sellercentral.amazon.co.jp/orders-v3';
const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tokyo' });

export default function AmazonSelfShipping({ task, onClose }: { task: DeliveryTask; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [order, setOrder] = useState<ShippingOrder | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => modal?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function lookup() {
      try {
        const { data, error } = await getSupabase().functions.invoke<ShippingOrder>('amazon-self-shipping', {
          body: { itemId: task.id }, signal: controller.signal,
        });
        if (error) {
          const response = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
          throw new Error(response?.error || 'Amazonの注文情報を取得できませんでした。');
        }
        if (!data || !/^\d{3}-\d{7}-\d{7}$/.test(data.orderId) ||
            data.account !== (task.sales_channel === '自己発送2' ? 'amazon-2' : 'amazon-1')) {
          throw new Error('対象のAmazon注文を確認できませんでした。');
        }
        if (!controller.signal.aborted) setOrder(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Amazonの注文を確認できませんでした。');
      }
    }
    void lookup();
    return () => controller.abort();
  }, [task.id, task.sales_channel, attempt]);

  return <dialog ref={dialog} className="workflow-confirmation amazon-self-shipping"
    aria-labelledby="amazon-self-shipping-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h3 id="amazon-self-shipping-title">Amazon自己発送</h3>
    <p className="amazon-self-shipping-product"><strong>{inventorySerial(task)} {task.model_no || task.title}</strong>
      <span>{salesChannelLabel(task.sales_channel)}</span></p>
    {order ? <>
      <dl className="amazon-self-shipping-order">
        <dt>注文状況</dt><dd>未出荷</dd>
        <dt>注文番号</dt><dd>{order.orderId}</dd>
        <dt>AmazonのSKU</dt><dd>{order.amazonSku}</dd>
        <dt>出荷期限</dt><dd>{order.shipBy ? dateFormat.format(new Date(order.shipBy)) : '—'}</dd>
      </dl>
      <p className="sub">セラーセントラルの注文詳細で配送先住所を確認します。</p>
    </> : error ? <p className="error" role="alert">{error}</p> : <p role="status">Amazonの未出荷注文を確認しています…</p>}
    <div className="workflow-confirmation-buttons amazon-self-shipping-actions">
      <button type="button" className="btn" onClick={onClose} autoFocus>閉じる</button>
      {error && <button type="button" className="btn" onClick={() => { setError(''); setAttempt(current => current + 1); }}>再試行</button>}
      {order ? <a className="btn primary" href={sellerCentral + '/order/' + order.orderId} target="_blank" rel="noopener noreferrer">配送先住所を確認</a>
        : error && <a className="btn" href={sellerCentral + '/mfn/unshipped'} target="_blank" rel="noopener noreferrer">セラーセントラルの未出荷一覧</a>}
    </div>
  </dialog>;
}
