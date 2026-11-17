import { useState, type FormEvent } from 'react';
import { getSupabase } from '@bussan/shared';

type Review = {
  sku: string;
  state: 'excluded' | 'hold';
  checkedAt: string;
  lastKnownEventOn: string | null;
  reviewOn: string | null;
  reasons: string[];
};
const dateTime = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tokyo',
});

export default function AmazonSoldOutReview() {
  const [sku, setSku] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !sku.trim()) return;
    setBusy(true);
    setReview(null);
    setError('');
    try {
      const { data, error: failure } = await getSupabase().functions.invoke<Review>('amazon-fba-inventory', {
        body: { action: 'review-sold-out', accountId: 'amazon-2', sku: sku.trim() },
      });
      if (failure) {
        const body = failure.context instanceof Response ? await failure.context.json().catch(() => null) : null;
        throw Error(typeof body?.error === 'string' ? body.error : 'Amazon2の確認に失敗しました。');
      }
      if (!data || data.sku !== sku.trim() || !Array.isArray(data.reasons)) throw Error('判定結果を取得できませんでした。');
      setReview(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Amazon2の確認に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <form onSubmit={check}>
      <label>Amazonの出品SKU <input value={sku} onChange={event => {
        setSku(event.target.value);
        setReview(null);
        setError('');
      }} required maxLength={160} disabled={busy} /></label>{' '}
      <button type="submit" className="btn" disabled={busy || !sku.trim()}>{busy ? '確認中…' : '確認する'}</button>
    </form>
    {error && <div role="alert" className="error">{error}</div>}
    {review && <div role="status" className="sub">
      <div>{review.state === 'excluded' ? '対象外' : '保留'}（{review.sku}、確認日時 {dateTime.format(new Date(review.checkedAt))}）</div>
      {review.lastKnownEventOn && <div>確認できた最終取引日 {review.lastKnownEventOn}／その1か月後 {review.reviewOn}</div>}
      <ul>{review.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
    </div>}
  </>;
}
