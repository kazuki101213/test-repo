import { staffDisplayName } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import Products from './pages/Products';
import Ledger from './pages/Ledger';
import ExpenseList from './components/ExpenseList';
import Spares from './pages/Spares';
import { disableDevicePush } from './push';

type Page = 'dashboard' | 'inventory' | 'spares' | 'expenses' | 'products' | 'ledger';

const NAV: { key: Page; label: string }[] = [
  { key: 'dashboard', label: 'ダッシュボード' },
  { key: 'inventory', label: '在庫' },
  { key: 'spares', label: '予備' },
  { key: 'expenses', label: '経費' },
  { key: 'products',  label: '商品リスト' },
  { key: 'ledger',    label: '古物台帳' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  async function logout() {
    try { await disableDevicePush(); await signOut(); await refresh(); }
    catch { setError('通知の停止またはログアウトに失敗しました。再度お試しください。'); }
  }

  async function refresh() {
    try {
      setSession(await loadSession());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSession(null);
    } finally {
      setChecked(true);
    }
  }

  useEffect(() => { void refresh(); }, []);

  if (!checked) return <div className="empty">読み込み中…</div>;

  if (!session) {
    return (
      <>
        <Login />
        {error && <div className="login"><div className="error">{error}</div></div>}
      </>
    );
  }

  // 納品担当者は大元アプリを開けない（RLS でもデータは見えないが、入口でも止める）
  if (session.staff.role === 'deliverer') {
    return (
      <div className="login">
        <div className="error">
          このアプリは管理者・仕入担当者向けです。納品アプリをお使いください。
        </div>
        <button className="btn" onClick={() => void signOut().then(refresh)}>ログアウト</button>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>物販管理</h1>
        <p className="who">{staffDisplayName(session.staff)}（{session.staff.role === 'admin' ? '管理者' : '仕入担当'}）</p>
        {NAV.filter(n => n.key !== 'expenses' || session.staff.role === 'admin').map((n) => (
          <button key={n.key} className="nav" data-active={page === n.key} onClick={() => setPage(n.key)}>
            {n.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="nav" onClick={() => void logout()}>ログアウト</button>
      </aside>

      <main>
        {error && <p className="error" role="alert">{error}</p>}
        {page === 'dashboard' && <Dashboard staff={session.staff} userId={session.user.id} />}
        {page === 'inventory' && <Inventory me={session.staff} />}
        {page === 'spares' && <Spares me={session.staff} />}
        {page === 'expenses' && session.staff.role === 'admin' && <ExpenseList revision={0} />}
        {page === 'products'  && <Products />}
        {page === 'ledger'    && <Ledger />}
      </main>
    </div>
  );
}
