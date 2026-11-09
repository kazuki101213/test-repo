import { useState, type FormEvent } from 'react';
import { signIn } from '@bussan/shared';

export default function Login() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setVerificationSent(false);
    try {
      if (await signIn(email) === 'signed-in') window.location.reload();
      else setVerificationSent(true);
    } catch (cause) {
      setError(cause instanceof Error && cause.message.startsWith('ログイン用のメール')
        ? cause.message : 'ログインできませんでした。登録済みの担当者メールアドレスを確認してください。');
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
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <p className="sub">入力したメールアドレスの担当者としてログインします。</p>
      </form>
      {verificationSent && <p role="status">メールに記載されたログインリンクを開いてください。</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
