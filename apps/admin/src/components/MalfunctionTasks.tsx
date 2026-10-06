import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';
import type { Staff } from '@bussan/shared';

const AUCTION_TEMPLATES = [
  'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
  'SONY◯ヤフオク', 'SONY×ヤフオク',
  'SHARP◯ヤフオク', 'SHARP×ヤフオク',
  'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク',
] as const;
const TASK_TEMPLATES = ['Amazon販売', '仕入先確認', ...AUCTION_TEMPLATES] as const;
type TaskKind = typeof TASK_TEMPLATES[number];
interface MalfunctionTask {
  id: string; sku: string; lot_seq: number; title: string; marketplace_item_id: string | null;
  purchaser_id: string | null; deliverer_id: string | null; malfunction_comment: string; malfunction_reported_at: string; malfunction_reported_by: string | null;
  products: { model_no: string | null; maker: string | null }[];
}
interface TaskComment {
  id: string; item_id: string; author_id: string; body: string; created_at: string;
  task_kind?: TaskKind | null; task_completed_at?: string | null;
  item_comment_photos?: { id: string; storage_path: string; sort_order: number }[];
  photos?: { id: string; url: string }[];
}
interface ActionTask {
  id: string; item_id: string; task_kind: TaskKind; task_completed_at: string | null; created_at: string;
  items: { lot_seq: number; marketplace_item_id: string | null; sku: string } | null;
}
const PHOTO_BUCKET = 'item-photos';
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function templateBody(kind: TaskKind, row: MalfunctionTask): string {
  const header = '【' + row.lot_seq + '】';
  if (kind === 'Amazon販売') return header + '\nAmazon販売お願いします。';
  if (kind === '仕入先確認') return header + '\n仕入先へ確認します。\nお待ちください。';
  return header + '\nヤフオク販売お願いします。\nリモコンやB-CASカードや電源ケーブルは予備としてください。\nイメージ写真に付属品が写っていれば付属させてください。\nイメージ写真は撮影ボックスで撮っていますが、床やテーブル等で撮ってください。\nトレイは開かない場合は開かなくて大丈夫です。\n写真は以下の通りです。';
}

async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('写真を読み込めません。JPEGまたはPNG画像を選択してください。'); }
  try {
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('写真を変換できません。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('写真の変換に失敗しました。')), 'image/jpeg', 0.82));
    if (blob.size > 8 * 1024 * 1024) throw new Error('写真1枚が8MBを超えています。写真を小さくしてから追加してください。');
    return new File([blob], 'reply.jpg', { type: 'image/jpeg' });
  } finally { bitmap.close(); }
}

async function fetchCommentRows(itemId: string): Promise<TaskComment[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from('item_comments')
    .select('id,item_id,author_id,body,created_at,task_kind,task_completed_at,item_comment_photos(id,storage_path,sort_order)')
    .eq('item_id', itemId).order('created_at');
  if (error) throw error;
  const rows = (data ?? []) as TaskComment[];
  const paths = rows.flatMap(row => (row.item_comment_photos ?? []).map(photo => photo.storage_path));
  const signed = paths.length ? await sb.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600) : { data: [] as { signedUrl?: string }[], error: null };
  if (signed.error) throw signed.error;
  let nextIndex = 0;
  for (const row of rows) {
    row.photos = (row.item_comment_photos ?? []).sort((a,b) => a.sort_order - b.sort_order).flatMap(photo => {
      const url = signed.data?.[nextIndex++]?.signedUrl;
      return url ? [{ id: photo.id, url }] : [];
    });
  }
  return rows;
}

function MalfunctionConversation({ item, staff }: { item: MalfunctionTask; staff: Staff }) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [authors, setAuthors] = useState<Map<string, string>>(new Map());
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<TaskKind | ''>('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingTemplatePhotos, setLoadingTemplatePhotos] = useState(false);
  const [error, setError] = useState('');

  async function refreshComments() {
    const rows = await fetchCommentRows(item.id);
    setComments(rows);
    const ids = [...new Set(rows.map(row => row.author_id))];
    if (ids.length) {
      const { data, error: peopleError } = await getSupabase().from('staff').select('id,name').in('id', ids);
      if (peopleError) throw peopleError;
      setAuthors(new Map((data ?? []).map(person => [person.id as string, person.name as string])));
    } else setAuthors(new Map());
  }

  useEffect(() => {
    let active = true;
    void refreshComments().catch(cause => { if (active) setError(messageOf(cause)); });
    return () => { active = false; };
  }, [item.id]);

  async function chooseTemplate(value: string) {
    setKind(value as TaskKind | '');
    setPhotos([]);
    setError('');
    if (!value) return;
    setDraft(templateBody(value as TaskKind, item));
    if (value !== 'Panasonic◯ヤフオク') return;
    setLoadingTemplatePhotos(true);
    try {
      const { data, error: photoError } = await getSupabase().from('item_comment_template_photos')
        .select('file_name,mime_type,photo_base64,sort_order')
        .eq('task_kind', value).order('sort_order');
      if (photoError) throw photoError;
      if (!data?.length) throw new Error('Panasonic◯ヤフオクの定型写真が登録されていません。');
      const files = (data as { file_name: string; mime_type: string; photo_base64: string; sort_order: number }[]).map(photo => {
        const bytes = Uint8Array.from(atob(photo.photo_base64), char => char.charCodeAt(0));
        return new File([bytes], photo.file_name, { type: photo.mime_type });
      });
      setPhotos(files);
    } catch (cause) {
      setError(messageOf(cause));
    } finally { setLoadingTemplatePhotos(false); }
  }

  async function sendReply() {
    const body = draft.trim();
    if ((!body && photos.length === 0) || busy) return;
    if (photos.length > 10) { setError('写真は一度に10枚まで追加できます。'); return; }
    setBusy(true); setError('');
    const sb = getSupabase();
    const commentId = crypto.randomUUID();
    const paths: string[] = [];
    try {
      if (kind.endsWith('ヤフオク')) {
        const { error: auctionError } = await sb.rpc('prepare_yahoo_auction_item', { p_item_id: item.id });
        if (auctionError) throw auctionError;
      }
      for (let index = 0; index < photos.length; index++) {
        const file = await prepareImage(photos[index]!);
        const path = item.sku + '/reply/' + commentId + '/' + String(index + 1).padStart(2, '0') + '.jpg';
        const { error: uploadError } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
        if (uploadError) throw uploadError;
        paths.push(path);
      }
      const { error: insertError } = await sb.from('item_comments').insert({
        id: commentId, item_id: item.id, author_id: staff.id, body: body || '写真を送信しました。', task_kind: kind || null,
      });
      if (insertError) throw insertError;
      if (paths.length) {
        const { error: photoError } = await sb.from('item_comment_photos').insert(paths.map((storage_path, sort_order) => ({
          item_comment_id: commentId, item_id: item.id, storage_path, sort_order,
        })));
        if (photoError) throw photoError;
      }
      setDraft(''); setKind(''); setPhotos([]);
      await refreshComments();
    } catch (cause) {
      if (paths.length) await sb.storage.from(PHOTO_BUCKET).remove(paths);
      await sb.from('item_comments').delete().eq('id', commentId);
      setError(messageOf(cause));
    } finally { setBusy(false); }
  }

  function choosePhotos(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files);
    if (selected.length > 10) { setError('写真は一度に10枚まで追加できます。'); return; }
    setPhotos(selected); setError('');
  }

  return <div className="malfunction-conversation">
    <strong>納品担当者とのメッセージ</strong>
    {comments.length === 0 && <p className="muted malfunction-empty-message">まだメッセージありません。</p>}
    {comments.map(comment => <div className={'comment ' + (comment.author_id === staff.id ? 'mine' : '')} key={comment.id}>
      <div className="meta">{authors.get(comment.author_id) ?? '担当者'} · {new Date(comment.created_at).toLocaleString('ja-JP')}</div>
      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{comment.body}</p>
      {comment.photos?.length ? <div className="malfunction-comment-photos">{comment.photos.map((photo, index) =>
        <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={'返信写真 ' + (index + 1)} loading="lazy" /></a>)}</div> : null}
    </div>)}
    <label className="field"><span>定型文</span><select aria-label="返信の定型文" value={kind} disabled={busy || loadingTemplatePhotos} onChange={event => void chooseTemplate(event.target.value)}>
      <option value="">定型文を選択（任意）</option>{TASK_TEMPLATES.map(value => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <textarea aria-label="納品担当者への返信" value={draft} onChange={event => setDraft(event.target.value)}
      maxLength={2000} placeholder="納品担当者への返信を入力" />
    <label className="btn photo-upload">{loadingTemplatePhotos ? '定型写真を読み込み中…' : ('写真追加（' + photos.length + '枚）')}
      <input type="file" aria-label="返信写真を追加" accept="image/*" multiple disabled={busy} onChange={event => { choosePhotos(event.target.files); event.target.value = ''; }} />
    </label>
    {error && <p className="error" role="alert">メッセージ：{error}</p>}
    <button className="btn primary" disabled={(!draft.trim() && photos.length === 0) || busy} onClick={() => void sendReply()}>
      {busy ? '送信中…' : '送信'}
    </button>
  </div>;
}

export default function MalfunctionTasks({ staff }: { staff: Staff }) {
  const [rows, setRows] = useState<MalfunctionTask[]>([]);
  const [actionTasks, setActionTasks] = useState<ActionTask[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    const sb = getSupabase();
    let query = sb.from('items')
      .select('id,sku,lot_seq,title,marketplace_item_id,purchaser_id,deliverer_id,malfunction_comment,malfunction_reported_at,malfunction_reported_by,products(model_no,maker)')
      .eq('malfunction_reported', true).is('malfunction_resolved_at', null);
    if (staff.role === 'purchaser') query = query.eq('purchaser_id', staff.id);
    const { data, error: queryError } = await query.order('malfunction_reported_at', { ascending: false });
    if (queryError) throw queryError;
    const tasks = (data ?? []) as MalfunctionTask[];
    setRows(tasks);
    const staffIds = [...new Set(tasks.flatMap(row => [row.malfunction_reported_by, row.purchaser_id, row.deliverer_id]).filter((id): id is string => !!id))];
    if (staffIds.length) {
      const { data: people, error: staffError } = await sb.from('staff').select('id,name').in('id', staffIds);
      if (staffError) throw staffError;
      setNames(new Map((people ?? []).map(person => [person.id as string, person.name as string])));
    } else setNames(new Map());
    if (staff.role === 'admin') {
      const { data: actions, error: actionError } = await sb.from('item_comments')
        .select('id,item_id,task_kind,task_completed_at,created_at,items!inner(lot_seq,marketplace_item_id,sku)')
        .not('task_kind', 'is', null).is('task_completed_at', null).order('created_at', { ascending: false });
      if (actionError) throw actionError;
      setActionTasks((actions ?? []) as unknown as ActionTask[]);
    } else setActionTasks([]);
    setError('');
  }

  useEffect(() => {
    let active = true;
    const load = () => { void refresh().catch(cause => { if (active) setError(messageOf(cause)); }); };
    load();
    const timer = window.setInterval(load, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [staff.id, staff.role]);

  async function completeTask(id: string) {
    setBusy(id); setError('');
    try {
      const { error: rpcError } = await getSupabase().rpc('complete_item_comment_task', { p_comment_id: id });
      if (rpcError) throw rpcError;
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  }

  async function resolve(id: string) {
    setBusy(id); setError('');
    try {
      const { error: rpcError } = await getSupabase().rpc('resolve_item_malfunction', { p_item_id: id });
      if (rpcError) throw rpcError;
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  }

  return <>
    {error && <li className="error" role="alert">動作不良タスク：{error}</li>}
    {!error && rows.length === 0 && actionTasks.length === 0 && <li className="muted">動作不良の報告はありません。</li>}
    {actionTasks.map(task => <li key={'action-' + task.id} className="malfunction-task-row">
      <div className="task-action-details"><strong>【{task.items?.lot_seq ?? '—'}】</strong> <a className="btn ghost" href={'https://bussan-delivery.vercel.app/?itemId=' + encodeURIComponent(task.item_id) + (task.task_kind === '仕入先確認' ? '&openMessages=1' : '')} target="_blank" rel="noreferrer">【{task.items?.marketplace_item_id ?? '商品ID未登録'}】</a> {task.task_kind.startsWith('Panasonic') || task.task_kind.startsWith('SONY') || task.task_kind.startsWith('SHARP') || task.task_kind.startsWith('TOSHIBA') ? 'ヤフオク販売' : task.task_kind}<small>{task.task_kind.includes('ヤフオク') ? task.task_kind : ''}</small></div>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => void completeTask(task.id)}>{busy === task.id ? '更新中…' : '完了'}</button>
    </li>)}
    {rows.map(row => <li key={'malfunction-' + row.id} className="malfunction-task-row">
      <div className="malfunction-task-content">
        <strong className="malfunction-task-heading">動作不良</strong>
        <div className="malfunction-task-metadata">
          <div><span>SKU</span><span>{row.sku}</span></div>
          <div><span>型番</span><span>{row.products?.[0]?.model_no || row.title || '—'}</span></div>
          <div><span>メーカー</span><span>{row.products?.[0]?.maker || '—'}</span></div>
          <div><span>納品担当者</span><span>{names.get(row.deliverer_id ?? '') ?? '未設定'}</span></div>
          <div><span>送信時間</span><span>{new Date(row.malfunction_reported_at).toLocaleString('ja-JP')}</span></div>
        </div>
        <p className="malfunction-report-message">DVD、ブルーレイともに読み込み不可。他動作は問題なし。</p>
        {row.malfunction_comment && row.malfunction_comment !== 'DVD、ブルーレイともに読み込み不可。他動作は問題なし。' && <p className="malfunction-original-comment">報告内容：{row.malfunction_comment}</p>}
        <MalfunctionConversation item={row} staff={staff} />
      </div>
      {staff.role === 'purchaser' && <button className="btn" disabled={busy !== null} onClick={() => void resolve(row.id)}>{busy === row.id ? '更新中…' : '対応完了'}</button>}
    </li>)}
  </>;
}
