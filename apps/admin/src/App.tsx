import { useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import NewPurchase from './pages/NewPurchase';
import Products from './pages/Products';
import Ledger from './pages/Ledger';

type Page = 'dashboard' | 'inventory' | 'new' | 'products' | 'ledger';

const NAV: { key: Page; label: string }[] = [
  { key: 'dashboard', label: 'ダッシュボード' },
  { key: 'new',       label: '仕入登録' },
  { key: 'inventory', label: '在庫一覧' },
  { key: 'products',  label: '商品マスタ' },
  { key: 'ledger',    label: '古物台帳' },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('dashboard');

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
        <Login onDone={() => void refresh()} />
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
        <p className="who">{session.staff.name}（{session.staff.role === 'admin' ? '管理者' : '仕入担当'}）</p>
        {NAV.map((n) => (
          <button key={n.key} className="nav" data-active={page === n.key} onClick={() => setPage(n.key)}>
            {n.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="nav" onClick={() => void signOut().then(refresh)}>ログアウト</button>
      </aside>

      <main>
        {page === 'dashboard' && <Dashboard />}
        {page === 'new'       && <NewPurchase me={session.staff} />}
        {page === 'inventory' && <Inventory />}
        {page === 'products'  && <Products />}
        {page === 'ledger'    && <Ledger />}
      </main>
    </div>
  );
}
