import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';
import type { Staff } from '@bussan/shared';

interface MalfunctionTask {
  id: string; sku: string; lot_seq: number; title: string; purchaser_id: string | null; malfunction_comment: string;
  malfunction_reported_at: string; malfunction_reported_by: string | null;
}
interface TaskComment {
  id: string; item_id: string; author_id: string; body: string; created_at: string;
}

function MalfunctionConversation({ itemId, staff }: { itemId: string; staff: Staff }) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [authors, setAuthors] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refreshComments() {
    const { data, error: queryError } = await getSupabase().from('item_comments')
      .select('id,item_id,author_id,body,created_at').eq('item_id', itemId).order('created_at');
    if (queryError) throw queryError;
    const rows = (data ?? []) as TaskComment[];
    setComments(rows);
    const ids = [...new Set(rows.map(row => row.author_id))];
    if (ids.length) {
      const { data: people, error: peopleError } = await getSupabase().from('staff').select('id,name').in('id', ids);
      if (peopleError) throw peopleError;
      setAuthors(new Map((people ?? []).map(person => [person.id as string, person.name as string])));
    } else setAuthors(new Map());
  }

  useEffect(() => {
    let active = true;
    void refreshComments().catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [itemId]);

  async function sendReply() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true); setError('');
    try {
      const { error: insertError } = await getSupabase().from('item_comments')
        .insert({ item_id: itemId, author_id: staff.id, body });
      if (insertError) throw insertError;
      setDraft('');
      await refreshComments();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="malfunction-conversation">
    <strong>納品担当者とのメッセージ</strong>
    {comments.length === 0 && <p className="muted">まだメッセージはありません。</p>}
    {comments.map(comment => <div className={`comment ${comment.author_id === staff.id ? 'mine' : ''}`} key={comment.id}>
      <div className="meta">{authors.get(comment.author_id) ?? '担当者'} · {new Date(comment.created_at).toLocaleString('ja-JP')}</div>
      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{comment.body}</p>
    </div>)}
    <textarea aria-label="納品担当者への返信" value={draft} onChange={event => setDraft(event.target.value)}
      maxLength={2000} placeholder="納品担当者への返信を入力" />
    <button className="btn primary" disabled={!draft.trim() || busy} onClick={() => void sendReply()}>
      {busy ? '送信中…' : '返信を送信'}
    </button>
    {error && <p className="error" role="alert">メッセージ：{error}</p>}
  </div>;
}

export default function MalfunctionTasks({ staff }: { staff: Staff }) {
  const [rows, setRows] = useState<MalfunctionTask[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    let query = getSupabase().from('items')
      .select('id,sku,lot_seq,title,purchaser_id,malfunction_comment,malfunction_reported_at,malfunction_reported_by')
      .eq('malfunction_reported', true).is('malfunction_resolved_at', null);
    if (staff.role === 'purchaser') query = query.eq('purchaser_id', staff.id);
    const { data, error: queryError } = await query.order('malfunction_reported_at', { ascending: false });
    if (queryError) throw queryError;
    const tasks = (data ?? []) as MalfunctionTask[];
    setRows(tasks);
    const staffIds = [...new Set(tasks.flatMap(row => [row.malfunction_reported_by, row.purchaser_id]).filter((id): id is string => !!id))];
    if (staffIds.length) {
      const { data: staffRows, error: staffError } = await getSupabase().from('staff').select('id,name').in('id', staffIds);
      if (staffError) throw staffError;
      setNames(new Map((staffRows ?? []).map(person => [person.id as string, person.name as string])));
    } else setNames(new Map());
    setError('');
  }

  useEffect(() => {
    let active = true;
    const load = () => { void refresh().catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); }); };
    load();
    const timer = window.setInterval(load, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [staff.id, staff.role]);

  async function resolve(id: string) {
    setBusy(id); setError('');
    try {
      const { error: rpcError } = await getSupabase().rpc('resolve_item_malfunction', { p_item_id: id });
      if (rpcError) throw rpcError;
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return <>
    {error && <li className="error" role="alert">動作不良タスク：{error}</li>}
    {!error && rows.length === 0 && <li className="muted">動作不良の報告はありません。</li>}
    {rows.map(row => <li key={`malfunction-${row.id}`} className="malfunction-task-row">
      <div><strong>動作不良 · {row.title}（{row.lot_seq}）</strong><small>SKU {row.sku} · 報告先 {names.get(row.purchaser_id ?? '') ?? '仕入担当者未設定'} · 報告者 {names.get(row.malfunction_reported_by ?? '') ?? '担当者不明'} · {new Date(row.malfunction_reported_at).toLocaleString('ja-JP')}</small>
        <p style={{ whiteSpace: 'pre-wrap' }}>{row.malfunction_comment}</p>
        <MalfunctionConversation itemId={row.id} staff={staff} />
      </div>
      {staff.role === 'purchaser' && <button className="btn" disabled={busy !== null} onClick={() => void resolve(row.id)}>{busy === row.id ? '更新中…' : '対応完了'}</button>}
    </li>)}
  </>;
}
