import { staffDisplayName } from '@bussan/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import TaskList from './pages/TaskList';
import Invoices from './pages/Invoices';
import Spares from './pages/Spares';
import PushSettings from './components/PushSettings';
import { disableDevicePush } from './push';
import { useCompactBidViewport } from './hooks/useCompactBidViewport';

const BidCalculator = lazy(() => import('./pages/BidCalculator'));
type Tab = 'tasks' | 'spares' | 'invoices' | 'bid-calculator' | 'notifications';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => window.location.hash === '#bid-calculator' ? 'bid-calculator' : 'tasks');
  const [invoiceNavigation, setInvoiceNavigation] = useState<'busy' | 'dirty' | null>(null);
  const compactBidViewport = useCompactBidViewport();
  const canLeave = () => invoiceNavigation !== 'busy' && (invoiceNavigation !== 'dirty' || window.confirm('保存していない請求書の変更を破棄しますか？'));
  function navigate(next: Tab) {
    if (next === tab) return;
    if (!canLeave()) return;
    setTab(next);
    if(next === 'bid-calculator') history.pushState(null,'',window.location.pathname+window.location.search+'#bid-calculator');
    else if(window.location.hash === '#bid-calculator') history.replaceState(null,'',window.location.pathname+window.location.search);
  }
  useEffect(() => {
    const sync=()=>{
      if (window.location.hash !== '#bid-calculator') { if(tab === 'bid-calculator') setTab('tasks'); return; }
      if (tab === 'bid-calculator') return;
      if (!canLeave()) { history.replaceState(null,'',window.location.pathname+window.location.search); return; }
      setTab('bid-calculator');
    };
    window.addEventListener('hashchange',sync);
    return ()=>window.removeEventListener('hashchange',sync);
  },[invoiceNavigation,tab]);
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
    <div className={tab === 'bid-calculator' && compactBidViewport ? 'app app-bid-calculator' : 'app'}>
      <div className="topbar">
        <div>
          <h1>納品アプリ</h1>
          <span className="who">{staffDisplayName(session.staff)}</span>
        </div>
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} onClick={() => void logout()}>ログアウト</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <nav className="row invoice-tabs no-print" aria-label="納品アプリのメニュー">
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'tasks' ? 'page' : undefined} onClick={() => navigate('tasks')}>在庫</button>
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'spares' ? 'page' : undefined} onClick={() => navigate('spares')}>予備</button>
        {['admin','purchaser'].includes(session.staff.role) && <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'bid-calculator' ? 'page' : undefined} onClick={() => navigate('bid-calculator')}>入札計算ツール</button>}
        <div className="invoice-notification-actions">
          <button className="btn ghost" aria-current={tab === 'invoices' ? 'page' : undefined} onClick={() => navigate('invoices')}>請求書・領収書</button>
          {['admin','deliverer'].includes(session.staff.role) && <button className="btn ghost" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'notifications' ? 'page' : undefined} aria-controls="notification-settings" onClick={() => navigate('notifications')}>通知設定</button>}
        </div>
      </nav>
      {tab === 'notifications' && ['admin','deliverer'].includes(session.staff.role) && <div id="notification-settings">
        <PushSettings key={session.user.id} userId={session.user.id} />
      </div>}
      {tab === 'notifications' ? null : tab === 'bid-calculator' ? (['admin','purchaser'].includes(session.staff.role) ? <Suspense fallback={<p>計算ツールを読み込み中…</p>}><BidCalculator /></Suspense> : <p className="error" role="alert">入札計算ツールは管理者・仕入担当者向けです。全在庫を確認できる権限が必要です。</p>) : tab === 'tasks' ? <TaskList staff={session.staff} /> : tab === 'spares' ? <Spares staff={session.staff} /> : <Invoices key={session.user.id} staff={session.staff} onNavigationChange={setInvoiceNavigation} />}
    </div>
  );
}
