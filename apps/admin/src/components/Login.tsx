import { useState, type FormEvent } from 'react';
import { signIn } from '@bussan/shared';

export default function Login() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await signIn(email);
      setNotice('ログイン用リンクをメールで送信しました。メールを開いてログインしてください。');
    } catch {
      setError('ログイン用メールを送信できませんでした。メールアドレスを確認して、もう一度お試しください。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h2>物販管理</h2>
      <p className="sub">管理アプリ</p>
      <form className="card" onSubmit={submit}>
        <input type="email" placeholder="メールアドレス" autoComplete="username"
               value={email} onChange={(e) => setEmail(e.target.value)} required />
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? '送信中…' : 'ログイン用リンクを送信'}
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
