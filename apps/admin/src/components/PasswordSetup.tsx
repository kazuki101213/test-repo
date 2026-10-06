import { adminAppUrl, deliveryAppUrl } from '../appUrls';
import { useEffect, useState, type FormEvent } from 'react';
import { getSupabase } from '@bussan/shared';

export default function PasswordSetup() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getSupabase().auth.getUser().then(({ data, error }) => {
      if (!active) return;
      if (error || !data.user) setError('リンクが無効または期限切れです。ログイン画面から再設定メールを送信してください。');
      else setReady(true);
    }).catch(() => { if (active) setError('ログイン状態を確認できません。時間をおいて開き直してください。'); });
    return () => { active = false; };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (password.length < 12) { setError('パスワードは12文字以上で入力してください。'); return; }
    if (password !== confirmation) { setError('確認用パスワードが一致しません。'); return; }
    setBusy(true);
    try {
      const { error } = await getSupabase().auth.updateUser({ password });
      if (error) throw error;
      setPassword(''); setConfirmation(''); setDone(true);
    } catch { setError('パスワードを設定できませんでした。別のパスワードを試すか、再設定メールを送り直してください。'); }
    finally { setBusy(false); }
  }
  return <div className="login">
    <h2>パスワードの設定</h2>
    {done ? <><p>設定しました。次回からメールアドレスとこのパスワードでログインできます。</p><p><a href={deliveryAppUrl}>納品アプリを開く</a></p><p><a href={adminAppUrl}>管理アプリを開く（管理者・編集担当者）</a></p></>
      : ready ? <form className="card" onSubmit={submit}>
        <label>新しいパスワード<input aria-label="新しいパスワード" type="password" autoComplete="new-password" minLength={12} value={password} onChange={e => setPassword(e.target.value)} required /></label>
        <label>パスワード（確認）<input aria-label="パスワード（確認）" type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={e => setConfirmation(e.target.value)} required /></label>
        <button className="btn primary" disabled={busy}>{busy ? '設定中…' : 'パスワードを設定'}</button>
      </form> : !error && <p role="status">招待・認証リンクを確認中…</p>}
    {error && <div className="error" role="alert">{error}</div>}
    <p><a href={import.meta.env.BASE_URL}>ログイン画面へ戻る</a></p>
  </div>;
}
