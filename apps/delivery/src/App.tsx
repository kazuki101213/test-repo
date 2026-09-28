import { useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';
import Invoices from './pages/Invoices';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<'tasks' | 'invoices'>('tasks');
  const [invoiceNavigation, setInvoiceNavigation] = useState<'busy' | 'dirty' | null>(null);
  const canLeave = () => invoiceNavigation !== 'busy' && (invoiceNavigation !== 'dirty' || window.confirm('保存していない請求書の変更を破棄しますか？'));

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
        {error && <div className="app"><div className="error">{error}</div></div>}
      </>
    );
  }

  if (openId) {
    return <TaskDetail itemId={openId} staff={session.staff} onBack={() => setOpenId(null)} />;
  }

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>納品アプリ</h1>
          <span className="who">{session.staff.display_name ?? session.staff.name}</span>
        </div>
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} onClick={() => { if (canLeave()) void signOut().then(refresh); }}>ログアウト</button>
      </div>
      <nav className="row invoice-tabs no-print" aria-label="納品アプリのメニュー">
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'tasks' ? 'page' : undefined} onClick={() => { if (canLeave()) setTab('tasks'); }}>商品一覧</button>
        <button className="btn ghost" aria-current={tab === 'invoices' ? 'page' : undefined} onClick={() => setTab('invoices')}>請求書・領収書</button>
      </nav>
      {tab === 'tasks' ? <TaskList onOpen={setOpenId} /> : <Invoices key={session.user.id} staff={session.staff} onNavigationChange={setInvoiceNavigation} />}
    </div>
  );
}
