import { useState, type FormEvent } from 'react';
import { signIn, getSupabase } from '@bussan/shared';

export default function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function resetPassword() {
    if (!email.trim()) { setError('メールアドレスを入力してください。'); return; }
    setBusy(true); setError(null); setNotice('');
    try {
      const { error } = await getSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + '/?setup=1' });
      if (error) throw error;
      setNotice('登録済みのメールアドレス宛に再設定メールを送信しました。届かない場合は管理者へご連絡ください。');
    } catch { setError('再設定メールを送信できませんでした。管理者へご連絡ください。'); }
    finally { setBusy(false); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>納品アプリ</h1>
      <p className="muted">担当している商品の作業状況を登録します。</p>
      <form className="card" onSubmit={submit}>
        <input
          type="email" placeholder="メールアドレス" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} required
        />
        <div className="password-field">
          <input id="login-password"
            type={showPassword ? 'text' : 'password'} placeholder="パスワード" aria-label="パスワード" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} required
          />
          <button className="btn" type="button" aria-controls="login-password" aria-pressed={showPassword}
                  aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'} onClick={() => setShowPassword(value => !value)}>
            {showPassword ? '隠す' : '表示'}
          </button>
        </div>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
      </form>
      <button className="btn" type="button" disabled={busy} onClick={() => void resetPassword()}>パスワードを忘れた・初回設定</button>
      {notice && <p role="status">{notice}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
