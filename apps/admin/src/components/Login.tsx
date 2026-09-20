import { useState, type FormEvent } from 'react';
import { signIn } from '@bussan/shared';

export default function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <h2>物販管理</h2>
      <p className="sub">在庫・納品・古物台帳の大元アプリ</p>
      <form className="card" onSubmit={submit}>
        <input type="email" placeholder="メールアドレス" autoComplete="username"
               value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="パスワード" autoComplete="current-password"
               value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
      </form>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
