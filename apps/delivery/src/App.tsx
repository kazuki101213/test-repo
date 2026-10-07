import { staffDisplayName } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import TaskList from './pages/TaskList';
import Invoices from './pages/Invoices';
import Spares from './pages/Spares';
import PushSettings from './components/PushSettings';
import { disableDevicePush } from './push';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'tasks' | 'spares' | 'invoices'>('tasks');
  const [invoiceNavigation, setInvoiceNavigation] = useState<'busy' | 'dirty' | null>(null);
  const canLeave = () => invoiceNavigation !== 'busy' && (invoiceNavigation !== 'dirty' || window.confirm('保存していない請求書の変更を破棄しますか？'));
  async function logout() {
    if (!canLeave()) return;
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
        {error && <div className="app"><div className="error">{error}</div></div>}
      </>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>納品アプリ</h1>
          <span className="who">{staffDisplayName(session.staff)}</span>
        </div>
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} onClick={() => void logout()}>ログアウト</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {['admin','deliverer'].includes(session.staff.role) && <PushSettings key={session.user.id} userId={session.user.id} />}
      <nav className="row invoice-tabs no-print" aria-label="納品アプリのメニュー">
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'tasks' ? 'page' : undefined} onClick={() => { if (canLeave()) setTab('tasks'); }}>在庫一覧</button>
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'spares' ? 'page' : undefined} onClick={() => { if (canLeave()) setTab('spares'); }}>予備一覧</button>
        <button className="btn ghost" aria-current={tab === 'invoices' ? 'page' : undefined} onClick={() => setTab('invoices')}>請求書・領収書</button>
      </nav>
      {tab === 'tasks' ? <TaskList staff={session.staff} /> : tab === 'spares' ? <Spares staff={session.staff} /> : <Invoices key={session.user.id} staff={session.staff} onNavigationChange={setInvoiceNavigation} />}
    </div>
  );
}
