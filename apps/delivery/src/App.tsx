import { useEffect, useState } from 'react';
import { loadSession, signOut } from '@bussan/shared';
import type { Session } from '@bussan/shared';
import Login from './components/Login';
import TaskList from './pages/TaskList';
import TaskDetail from './pages/TaskDetail';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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
        <button className="btn ghost" onClick={() => void signOut().then(refresh)}>ログアウト</button>
      </div>
      <TaskList onOpen={setOpenId} />
    </div>
  );
}
