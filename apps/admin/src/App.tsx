import { canOpenManagementPage, switchApplication, staffDisplayName } from '@bussan/shared';
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
  const visiblePage: Page = session && canOpenManagementPage(session.staff, page) ? page : 'inventory';
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
        <button className="btn" onClick={() => switchApplication('delivery')}>納品アプリへ</button>
        <button className="btn" onClick={() => void signOut().then(refresh)}>ログアウト</button>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>管理アプリ</h1>
        <p className="who">{staffDisplayName(session.staff)}<span className="management-role">（{session.staff.role === 'admin' ? '管理者' : '仕入担当'}）</span></p>
        <div className="management-header-actions"><button type="button" className="btn ghost" onClick={() => switchApplication('delivery')}>納品アプリへ</button><button type="button" className="btn ghost" onClick={() => void logout()}>ログアウト</button></div>
        <nav className="management-navigation" aria-label="管理アプリのメニュー">
        {NAV.filter(n => canOpenManagementPage(session.staff, n.key)).map((n) => (
          <button key={n.key} className="nav" aria-current={visiblePage === n.key ? 'page' : undefined} data-active={visiblePage === n.key} onClick={() => setPage(n.key)}>
            {n.label}
          </button>
        ))}
        </nav>
      </aside>

      <main>
        {error && <p className="error" role="alert">{error}</p>}
        {visiblePage === 'dashboard' && <Dashboard staff={session.staff} userId={session.user.id} />}
        {visiblePage === 'inventory' && <Inventory me={session.staff} />}
        {visiblePage === 'spares' && <Spares me={session.staff} />}
        {visiblePage === 'expenses' && session.staff.role === 'admin' && <ExpenseList revision={0} />}
        {visiblePage === 'products'  && <Products />}
        {visiblePage === 'ledger'    && <Ledger />}
      </main>
    </div>
  );
}
