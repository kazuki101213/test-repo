import { canOpenManagement, switchApplication, staffDisplayName } from '@bussan/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import TaskList from './pages/TaskList';
import Invoices from './pages/Invoices';
import { findInvoice } from './invoices';
import Spares from './pages/Spares';
import PushSettings from './components/PushSettings';
import LineSettings from './components/LineSettings';
import { disableDevicePush } from './push';
import { useCompactBidViewport } from './hooks/useCompactBidViewport';

const BidCalculator = lazy(() => import('./pages/BidCalculator'));
const FbaDelivery = lazy(() => import('./pages/FbaDelivery'));
type Tab = 'tasks' | 'fba' | 'spares' | 'invoices' | 'bid-calculator' | 'notifications';
type ApprovedInvoiceTarget = { id: string; month: string };

function approvedInvoiceTarget(): ApprovedInvoiceTarget | null {
  const query = new URLSearchParams(window.location.search);
  const id = query.get('invoiceId');
  const month = query.get('invoiceMonth');
  return id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) &&
    month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? { id, month } : null;
}

function ApprovedInvoiceLink({ target, staff, onNavigationChange }: {
  target: ApprovedInvoiceTarget; staff: Session['staff']; onNavigationChange: (state: 'busy' | 'dirty' | null) => void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus('loading');
    void findInvoice(staff.id, target.month).then(invoice => {
      if (active) setStatus(invoice?.id === target.id && !!invoice.approved_at ? 'ready' : 'denied');
    }).catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [staff.id, target.id, target.month, revision]);
  if (status === 'loading') return <p role="status">承認済みの請求書を確認しています…</p>;
  if (status === 'error') return <p className="error" role="alert">請求書を確認できませんでした。 <button className="btn" onClick={() => setRevision(value => value + 1)}>再読み込み</button></p>;
  if (status === 'denied') return <p className="error" role="alert">この請求書を確認できません。通知を受け取った納品担当者のアカウントでログインしてください。</p>;
  return <Invoices staff={staff} onNavigationChange={onNavigationChange} initialMonth={target.month} />;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fbaSelectedIds,setFbaSelectedIds] = useState<string[]>([]);
  const [invoiceTarget, setInvoiceTarget] = useState(approvedInvoiceTarget);
  const [tab, setTab] = useState<Tab>(() => invoiceTarget ? 'invoices' : window.location.hash === '#bid-calculator' ? 'bid-calculator' : 'tasks');
  const [invoiceNavigation, setInvoiceNavigation] = useState<'busy' | 'dirty' | null>(null);
  const compactBidViewport = useCompactBidViewport();
  const canLeave = () => invoiceNavigation !== 'busy' && (invoiceNavigation !== 'dirty' || window.confirm('保存していない請求書の変更を破棄しますか？'));
  function navigate(next: Tab) {
    if (next === tab) return;
    if (!canLeave()) return;
    if (invoiceTarget) {
      const url = new URL(window.location.href);
      url.searchParams.delete('invoiceId');
      url.searchParams.delete('invoiceMonth');
      history.replaceState(null, '', url);
      setInvoiceTarget(null);
    }
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
  useEffect(() => {setFbaSelectedIds([]);}, [session?.user.id]);

  if (!checked) return <div className="empty">読み込み中…</div>;

  if (!session) {
    return (
      <>
        <Login />
        {error && <div className="app"><div className="error">{error}</div></div>}
      </>
    );
  }

  const inventoryTab=tab==='tasks'||tab==='fba'||tab==='spares';
  return (
    <div className={tab === 'bid-calculator' && compactBidViewport ? 'app app-bid-calculator' : 'app'}>
      <div className="topbar">
        <div>
          <span className="who">{staffDisplayName(session.staff)}</span>
        </div>
        <div className="app-switch-actions">{canOpenManagement(session.staff) && <button type="button" className="btn ghost" disabled={invoiceNavigation === 'busy'} onClick={() => { if (canLeave()) switchApplication('management'); }}>管理アプリへ</button>}
        <button className="btn ghost" disabled={invoiceNavigation === 'busy'} onClick={() => void logout()}>ログアウト</button></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <nav className="row invoice-tabs delivery-navigation no-print" aria-label="納品アプリのメニュー">
        <button className="btn ghost" data-tab="tasks" disabled={invoiceNavigation === 'busy'} aria-current={inventoryTab ? 'page' : undefined} onClick={() => navigate('tasks')}>在庫</button>
        <button className="btn ghost" data-tab="invoices" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'invoices' ? 'page' : undefined} onClick={() => navigate('invoices')}>請求書・領収書</button>
        {['admin','purchaser'].includes(session.staff.role) && <button className="btn ghost" data-tab="bid-calculator" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'bid-calculator' ? 'page' : undefined} onClick={() => navigate('bid-calculator')}>入札計算ツール</button>}
        <button className="btn ghost" data-tab="notifications" disabled={invoiceNavigation === 'busy'} aria-current={tab === 'notifications' ? 'page' : undefined} aria-controls="notification-settings" onClick={() => navigate('notifications')}>通知設定</button>
      </nav>
      {inventoryTab&&<nav className="row delivery-stock-navigation no-print" aria-label="在庫の切り替え">
        <button type="button" className="btn" aria-current={tab==='tasks'?'page':undefined} onClick={()=>navigate('tasks')}>在庫</button>
        <button type="button" className="btn" aria-current={tab==='fba'?'page':undefined} onClick={()=>navigate('fba')}>FBA納品</button>
        <button type="button" className="btn" aria-current={tab==='spares'?'page':undefined} onClick={()=>navigate('spares')}>予備</button>
      </nav>}
      {tab === 'notifications' && <div id="notification-settings">
        <PushSettings key={session.user.id} userId={session.user.id} />
        <LineSettings key={`line-${session.user.id}`} userId={session.user.id} />
      </div>}
      {tab === 'notifications' ? null : tab === 'bid-calculator' ? (['admin','purchaser'].includes(session.staff.role) ? <Suspense fallback={<p>計算ツールを読み込み中…</p>}><BidCalculator /></Suspense> : <p className="error" role="alert">入札計算ツールは管理者・仕入担当者向けです。全在庫を確認できる権限が必要です。</p>) : tab === 'tasks' ? <TaskList staff={session.staff} selectedIds={fbaSelectedIds} onSelectionChange={setFbaSelectedIds} onFbaDelivery={()=>navigate('fba')} /> : tab === 'fba' ? <Suspense fallback={<p>納品する商品を読み込み中…</p>}><FbaDelivery key={session.user.id} staff={session.staff} itemIds={fbaSelectedIds} onSelectionChange={setFbaSelectedIds} onBack={()=>navigate('tasks')} /></Suspense> : tab === 'spares' ? <Spares staff={session.staff} /> : invoiceTarget ? <ApprovedInvoiceLink key={session.user.id} staff={session.staff} target={invoiceTarget} onNavigationChange={setInvoiceNavigation} /> : <Invoices key={session.user.id} staff={session.staff} onNavigationChange={setInvoiceNavigation} />}
    </div>
  );
}
