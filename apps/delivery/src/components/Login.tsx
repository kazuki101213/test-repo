import { useState, type FormEvent } from 'react';
import { signIn } from '@bussan/shared';

export default function Login() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email);
      window.location.reload();
    } catch {
      setError('ログインできませんでした。登録済みの担当者メールアドレスを確認してください。');
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
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <p className="muted">入力したメールアドレスの担当者としてログインします。</p>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
