import ReturnReasonDialog from './ReturnReasonDialog';
import { useTaskConfirmation } from './TaskConfirmation';
import MalfunctionReportPhotos from './MalfunctionReportPhotos';
import { productSerial } from '../inventory';
import { readResourceSnapshot } from '@bussan/shared';
import { managementWorkflowButtons, staffDisplayName, workflowButtonDirection } from '@bussan/shared';
import { deliveryAppUrl } from '../appUrls';
import { purchaseItemUrl } from '../purchaseUrl';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { adminTaskNotice } from '../taskNotice';
import { getSupabase } from '@bussan/shared';
import type { Staff, ItemStatus, InventoryAction } from '@bussan/shared';

const PHOTO_AUCTION_TEMPLATES = [
  'Panasonic◯ヤフオク', 'Panasonic×ヤフオク',
  'SONY◯ヤフオク', 'SONY×ヤフオク',
  'SHARP◯ヤフオク', 'SHARP×ヤフオク',
  'TOSHIBA◯ヤフオク', 'TOSHIBA×ヤフオク',
] as const;
const TASK_TEMPLATES = ['仕入先確認', ...PHOTO_AUCTION_TEMPLATES, 'ヤフオク その他'] as const;
type TaskKind = typeof TASK_TEMPLATES[number];
interface MalfunctionTask {
  status: ItemStatus; id: string; sku: string; lot_seq: number; title: string; asin: string | null; marketplace_item_id: string | null;
  purchaser_id: string | null; deliverer_id: string | null; malfunction_comment: string; malfunction_reported_at: string; malfunction_reported_by: string | null;
  products: { model_no: string | null }[];
}
type PurchaseSource = { id: string; marketplace: string | null; marketplace_item_id: string | null; marketplace_url: string | null };
interface TaskComment {
  id: string; item_id: string; author_id: string; body: string; created_at: string;
  task_kind?: TaskKind | null; task_completed_at?: string | null;
  item_comment_photos?: { id: string; storage_path: string; sort_order: number }[];
  photos?: { id: string; url: string }[];
}
interface ActionTask {
  id: string; item_id: string; task_kind: TaskKind; task_completed_at: string | null; created_at: string;
  lot_seq: number; marketplace_item_id: string | null; sku: string;
}
const PHOTO_BUCKET = 'item-photos';
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function templateBody(kind: TaskKind, row: MalfunctionTask): string {
  const model = row.products?.find(product => product.model_no)?.model_no || '型番未登録';
  const header = '【' + productSerial(row.sku, row.lot_seq) + '】【' + (row.marketplace_item_id || '商品ID未登録') + '】【' + model + '】';
  if (kind === '仕入先確認') return header + '\n取引メッセージより仕入先へ連絡お願いします。';
  if (kind === 'ヤフオク その他') return header + '\nヤフオク販売お願いします。\n【写真に関して】\n付属品はすべてつけてください。\n撮影ボックスではなくて、床やテーブル等で撮ってください。\n電源が確認できるものであれば、確認できるような写真お願いします。';
  return header + '\nヤフオク販売お願いします。\nリモコンやB-CASカードや電源ケーブルは予備としてください。\n【写真に関して】\n付属品が写っていれば付属させてください。\n撮影ボックスで撮っていますが、床やテーブル等で撮ってください。\nランプや表示は写真の通りお願いします。\nトレイは開かない場合は開かなくて大丈夫です。\n写真は以下の通りです。';
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

function MalfunctionConversation({ item, staff, onReplied, actions }: { item: MalfunctionTask; staff: Staff; onReplied: () => Promise<void>; actions: ReactNode }) {
  const { ask, pending, confirmation } = useTaskConfirmation();
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
      setAuthors(new Map((data ?? []).map(person => [person.id as string, staffDisplayName(person.name)])));
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
    if (!(PHOTO_AUCTION_TEMPLATES as readonly string[]).includes(value)) return;
    setLoadingTemplatePhotos(true);
    try {
      const { data, error: photoError } = await getSupabase().from('item_comment_template_photos')
        .select('file_name,mime_type,photo_base64,sort_order')
        .eq('task_kind', value).order('sort_order');
      if (photoError) throw photoError;
      if (!data?.length) throw new Error(value + 'の定型写真が登録されていません。');
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
    let saved = false;
    try {
      for (let index = 0; index < photos.length; index++) {
        const file = await prepareImage(photos[index]!);
        const path = item.sku + '/reply/' + commentId + '/' + String(index + 1).padStart(2, '0') + '.jpg';
        const { error: uploadError } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
        if (uploadError) throw uploadError;
        paths.push(path);
      }
      const { error: insertError } = await sb.rpc('send_malfunction_reply', {
        p_comment_id: commentId, p_item_id: item.id, p_body: body || '写真を送信しました。', p_task_kind: kind || null,
        p_photo_paths: paths,
      });
      if (insertError) throw insertError;
      saved = true;
      setDraft(''); setKind(''); setPhotos([]);
      await refreshComments();
      await onReplied();
    } catch (cause) {
      // An uncertain response may have committed. Never remove a successfully saved reply's photos.
      if (!saved) {
        const { data: existing, error: lookupError } = await sb.from('item_comments').select('id').eq('id', commentId).maybeSingle();
        if (!lookupError && !existing && paths.length) await sb.storage.from(PHOTO_BUCKET).remove(paths);
      }
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
    <div className="malfunction-conversation-body">
    <strong className="task-conversation-title">納品担当者とのメッセージ</strong>
    <div className="task-conversation-history">
    {comments.length === 0 && <p className="muted malfunction-empty-message">まだメッセージありません。</p>}
    {comments.map(comment => <div className={'comment ' + (comment.author_id === staff.id ? 'mine' : '')} key={comment.id}>
      <div className="meta">{staffDisplayName(authors.get(comment.author_id)) || '担当者'} · {new Date(comment.created_at).toLocaleString('ja-JP')}</div>
      <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{comment.body}</p>
      {comment.photos?.length ? <div className="malfunction-comment-photos">{comment.photos.map((photo, index) =>
        <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={'返信写真 ' + (index + 1)} loading="lazy" /></a>)}</div> : null}
    </div>)}
    </div>
    <div className="task-template-row"><select aria-label="返信の定型文" value={kind} disabled={busy || pending || loadingTemplatePhotos} onChange={event => void chooseTemplate(event.target.value)}>
      <option value="">定型文選択</option>{TASK_TEMPLATES.map(value => <option key={value} value={value}>{value}</option>)}
    </select><button type="button" className="btn task-reply-send" disabled={(!draft.trim() && photos.length === 0) || busy || pending || loadingTemplatePhotos}
      onClick={() => ask('納品担当者とのメッセージ：送信', sendReply)}>{busy ? '送信中…' : '送信'}</button></div>
    <div className="task-reply-editor"><textarea aria-label="納品担当者への返信" value={draft} disabled={busy || pending} onChange={event => setDraft(event.target.value)}
      maxLength={2000} placeholder="納品担当者への返信を入力" />
    <label className="btn photo-upload">{loadingTemplatePhotos ? '定型写真を読み込み中…' : ('写真追加（' + photos.length + '枚）')}
      <input type="file" aria-label="返信写真を追加" accept="image/*" multiple disabled={busy || pending || loadingTemplatePhotos} onChange={event => { choosePhotos(event.target.files); event.target.value = ''; }} />
    </label>
    {error && <p className="error" role="alert">メッセージ：{error}</p>}
    </div></div>
    <div className="malfunction-management-actions">{actions}</div>
    {confirmation}
  </div>;
}

export default function MalfunctionTasks({ staff }: { staff: Staff }) {
  const { ask, pending, confirmation } = useTaskConfirmation();
  const notice = adminTaskNotice();
  const noticeHandled = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [noticeMessage, setNoticeMessage] = useState('');
  const [rows, setRows] = useState<MalfunctionTask[]>([]);
  const [purchaseSources, setPurchaseSources] = useState<Map<string, PurchaseSource>>(new Map());
  const [actionTasks, setActionTasks] = useState<ActionTask[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const pendingRefresh=useRef<Promise<void>|null>(null);
  const alive=useRef(true);
  async function refresh() {
    if(pendingRefresh.current)return pendingRefresh.current;
    const load=async()=>{
    const [tasks,actions] = await Promise.all([
      readResourceSnapshot<MalfunctionTask & {maker:string|null;people:{id:string|null;name:string|null}[]}>('malfunctions'),
      staff.role==='admin'?readResourceSnapshot<ActionTask & {id:string;created_at:string}>('actions'):Promise.resolve([]),
    ]);
    const references = tasks.length ? await getSupabase().from('items')
      .select('id,marketplace,marketplace_item_id,marketplace_url').in('id', tasks.map(row => row.id))
      : { data: [], error: null };
    if(!alive.current)return;
    setPurchaseSources(new Map((references.data ?? []).map(row => [row.id, row as PurchaseSource])));
    setRows([...tasks].sort((a,b)=>b.malfunction_reported_at.localeCompare(a.malfunction_reported_at)));
    setActionTasks(actions.filter(task=>task.task_kind!=='仕入先確認'&&!task.task_kind.includes('ヤフオク')).sort((a,b)=>b.created_at.localeCompare(a.created_at)));
    setError(references.error ? '仕入先リンクを取得できませんでした。次回更新時に再取得します。' : '');
    setLoaded(true);
    };
    const request=load();pendingRefresh.current=request;
    try{await request;}finally{pendingRefresh.current=null;}
  }

  useEffect(() => {
    if (!loaded || noticeHandled.current || !notice || !['malfunction','action'].includes(notice.kind)) return;
    noticeHandled.current = true;
    const id = notice.kind === 'malfunction' ? notice.itemId : notice.taskId;
    const found = notice.kind === 'malfunction' ? rows.some(row => row.id === id) : actionTasks.some(task => task.id === id);
    if (found) document.getElementById(`admin-${notice.kind}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else setNoticeMessage('通知のタスクはすでに対応済みか、現在は確認できません。');
  }, [loaded, rows, actionTasks]);

  useEffect(() => {
    let active = true;alive.current=true;
    const load = () => { void refresh().catch(cause => { if (active) setError(messageOf(cause)); }); };
    load();
    const timer = window.setInterval(() => { if(document.visibilityState==='visible') load(); }, 300000);
    return () => { active = false; alive.current=false; window.clearInterval(timer); };
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

  async function completeCompensationReport(row:MalfunctionTask){
    const {error}=await getSupabase().rpc('complete_compensation_report',{p_item_id:row.id,p_reported_at:row.malfunction_reported_at});
    if(error)throw error;await refresh();
  }
  const [returning,setReturning]=useState<MalfunctionTask|null>(null);
  const returnRequest=useRef('');
  async function returnReport(reason:string){
    if(!returning)return;
    const {error:returnError}=await getSupabase().rpc('perform_inventory_action',{p_item_id:returning.id,p_action:'send_back',p_expected_status:returning.status,p_note:reason,p_request_id:returnRequest.current});
    if(returnError)throw returnError;
    await refresh();setReturning(null);
  }
  async function resolve(row: MalfunctionTask, action: InventoryAction) {
    setBusy(row.id); setError('');
    try {
      const { error: rpcError } = await getSupabase().rpc('perform_inventory_action', {p_item_id:row.id,p_action:action,p_expected_status:row.status,p_request_id:crypto.randomUUID(),p_note:null});
      if (rpcError) throw rpcError;
      await refresh();
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(null); }
  }

  return <>
    {noticeMessage && <li role="status">{noticeMessage}</li>}
    {error && <li className="error" role="alert">動作不良タスク：{error}</li>}
    {!error && rows.length === 0 && actionTasks.length === 0 && <li className="muted">動作不良の報告はありません。</li>}
    {actionTasks.map(task => <li id={`admin-action-${task.id}`} key={'action-' + task.id} className="malfunction-task-row admin-task-card admin-simple-task">
      <div className="task-action-details supplier-task-details"><strong>{task.task_kind}</strong><a className="listing-inventory-link" href={deliveryAppUrl+'?itemId='+encodeURIComponent(task.item_id)} target="_blank" rel="noopener noreferrer" aria-label="仕入先確認商品の在庫を開く">【{productSerial(task.sku,task.lot_seq)}】</a><a href={deliveryAppUrl+'?itemId='+encodeURIComponent(task.item_id)+'&openMessages=1'} target="_blank" rel="noopener noreferrer" aria-label="仕入先確認のメッセージを開く">【{task.marketplace_item_id || '商品ID未登録'}】</a><small>{task.sku}</small></div>
      <button type="button" className="btn" disabled={busy !== null || pending} onClick={() => ask('仕入先確認：完了', () => completeTask(task.id))}>{busy === task.id ? '更新中…' : '完了'}</button>
    </li>)}
    {rows.map(row => {
      const source = purchaseSources.get(row.id);
      const sourceUrl = purchaseItemUrl(source?.marketplace ?? null, source?.marketplace_item_id ?? row.marketplace_item_id, source?.marketplace_url ?? null);
      const controls = (staff.role === 'admin' || staff.role === 'purchaser') && <div className="workflow-buttons">{row.status==='Amazon補填申請中'&&<button type="button" className="btn" data-action="complete_compensation_report" data-direction="back" disabled={busy!==null||pending} onClick={()=>ask('破損報告：完了',()=>completeCompensationReport(row))}>完了</button>}{managementWorkflowButtons(row.status).filter(button=>!['yahoo_instruction','compensation_complete','compensation_denied'].includes(button.key)).sort((a,b)=>['supplier_check','compensation_complete','compensation_denied','send_back'].indexOf(a.key)-['supplier_check','compensation_complete','compensation_denied','send_back'].indexOf(b.key)).map(button=><button key={button.key} className="btn" data-action={button.key} data-direction={workflowButtonDirection(button.key)} disabled={busy !== null || pending} onClick={()=>{if(button.key==='send_back'){returnRequest.current=crypto.randomUUID();setReturning(row);}else ask((row.status === '動作不良' ? '動作不良' : '破損報告')+'：'+button.label,()=>resolve(row,button.key as InventoryAction));}}>{button.label}</button>)}</div>;
      return <li id={`admin-malfunction-${row.id}`} key={'malfunction-' + row.id} className={`malfunction-task-row admin-task-card ${row.status === '動作不良' ? 'malfunction-report-row admin-fault-task' : 'admin-damage-task'}`}>
      <div className="malfunction-task-content">
        <div className="task-action-details malfunction-report-details">
          <strong>{row.status === 'Amazon補填申請中' ? '破損報告' : '動作不良'}</strong>
          <a className="listing-inventory-link" href={deliveryAppUrl+'?itemId='+encodeURIComponent(row.id)} target="_blank" rel="noopener noreferrer" aria-label="報告商品の在庫を開く">【{productSerial(row.sku,row.lot_seq)}】</a>
          {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="仕入先の商品ページを開く">【{(source?.marketplace_item_id ?? row.marketplace_item_id) || '商品ID未登録'}】</a> : <span>【{(source?.marketplace_item_id ?? row.marketplace_item_id) || '商品ID未登録'}】</span>}
          <small>{row.sku}</small>
        </div>

        <p className="malfunction-report-message" style={{ whiteSpace: 'pre-wrap' }}>{row.malfunction_comment || '報告内容が登録されていません。'}</p>
        <MalfunctionReportPhotos key={row.malfunction_reported_at} itemId={row.id} />
      </div>
      {row.status === '動作不良' ? <MalfunctionConversation item={{...row, marketplace_item_id: source?.marketplace_item_id ?? row.marketplace_item_id}} staff={staff} onReplied={refresh} actions={controls} /> : controls}
    </li>;})}
    {returning&&<ReturnReasonDialog label={(returning.status==='動作不良'?'動作不良':'破損報告')+'：差し戻し'} onSubmit={returnReport} onCancel={()=>setReturning(null)}/>}
    {confirmation}
  </>;
}
