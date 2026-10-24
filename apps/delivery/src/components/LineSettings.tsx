import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '@bussan/shared';

type Status = { configured: boolean; officialUrl: string | null; linked: boolean; blocked: boolean; shippingEnabled: boolean };
async function request<T>(action: string): Promise<T> {
  const { data, error } = await getSupabase().functions.invoke<T>('delivery-line', { body: { action } });
  if (error) throw new Error('LINE設定を確認できませんでした。少し待ってから再度お試しください。');
  return data as T;
}
export default function LineSettings({ userId }: { userId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState<{ message: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true; mounted.current = true;
    void request<Status>('status').then(value => { if (active) setStatus(value); }).catch(() => {
      if (active) setMessage('LINE設定を確認できませんでした。「登録状況を確認」から再度お試しください。');
    });
    return () => { active = false; mounted.current = false; };
  }, [userId]);
  async function act(action: 'status' | 'issue' | 'unlink') {
    if (inFlight.current) return;
    if (action === 'unlink' && !window.confirm('この担当者のLINE連携を解除しますか？')) return;
    inFlight.current = true; setBusy(true); setMessage('');
    try {
      if (action === 'issue') {
        const value = await request<{ message: string; expiresAt: string }>('issue');
        if (mounted.current) setCode(value);
      } else {
        if (action === 'unlink') await request('unlink');
        const value = await request<Status>('status');
        if (mounted.current) {
          setStatus(value);
          if (value.linked && !value.blocked || action === 'unlink') setCode(null);
        }
      }
    } catch (cause) { if (mounted.current) setMessage(cause instanceof Error ? cause.message : 'LINE設定に失敗しました。'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="card no-print" aria-label="LINE通知設定">
    <div className="row notification-controls">
      <span>LINE通知：{!status ? message ? '未確認' : '確認中' : status.blocked ? 'ブロック中・再登録が必要' : status.linked ? '登録済み' : '未登録'}</span>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => void act('status')}>登録状況を確認</button>
      {status?.linked && <button type="button" className="btn ghost" disabled={busy} onClick={() => void act('unlink')}>連携を解除</button>}
    </div>
    {status && !status.configured ? <p className="muted">LINE公式アカウントの接続準備中です。設定後、この画面から登録できます。</p>
      : status?.configured && <>
        <p>公式アカウントを友だち追加し、連携コードを公式アカウントのトークへ送信してください。</p>
        <div className="row notification-controls">
          {status.officialUrl && <a className="btn ghost" href={status.officialUrl} target="_blank" rel="noreferrer">友だち追加</a>}
          {(!status.linked || status.blocked) && <button type="button" className="btn ghost" disabled={busy} onClick={() => void act('issue')}>連携コードを発行</button>}
        </div>
        {code && <div>
          <label>トークに送信する連携コード<input aria-label="連携コード" readOnly value={code.message} onFocus={event => event.target.select()} /></label>
          <button type="button" className="btn ghost" onClick={() => void navigator.clipboard.writeText(code.message).then(() => setMessage('コピーしました。公式アカウントへ送信してください。')).catch(() => setMessage('入力欄のコードを選択してコピーしてください。'))}>コピー</button>
          <p className="muted">有効期限：{new Date(code.expiresAt).toLocaleTimeString('ja-JP')}。他の人には渡さないでください。</p>
        </div>}
        <p className="muted">{status.shippingEnabled ? '登録後に発生する担当商品の発送依頼をLINEでお知らせします。' : '担当者の登録を受け付けています。発送依頼の配信は準備中です。'}</p>
      </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
