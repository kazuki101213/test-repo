import ReturnReasonDialog from './ReturnReasonDialog';
import { useTaskConfirmation } from './TaskConfirmation';
import { purchaseItemUrl } from '../purchaseUrl';
import { productSerial } from '../inventory';
import { useEffect, useRef, useState } from 'react';
import { adminTaskNotice } from '../taskNotice';
import { createPortal } from 'react-dom';
import { getSupabase, readResourceSnapshot } from '@bussan/shared';
import { preparePhotoFiles, savePhotoFiles } from '../photoSave';
import {readReviewPhotos} from '../reviewPhotos';
import { deliveryAppUrl } from '../appUrls';

interface Review { item_id: string; drive_folder_id: string; submitted_at: string; exported_photo_count: number }
interface PurchaseReference { marketplace_item_id?: string | null; marketplace?: string | null; marketplace_url?: string | null }
interface Item extends PurchaseReference { id: string; sku: string; title: string; lot_seq: number; sales_channel?:string|null }
interface ListingTask extends PurchaseReference { id: string; sku: string; lot_seq: number; sales_channel: string; marketplace_item_id?: string | null }

async function listingProductIds(tasks: ListingTask[]): Promise<ListingTask[]> {
  const ids = new Map<string, PurchaseReference>();
  // Fetch purchase links only for current review/listing tasks; keep each response below row limits.
  for (let offset = 0; offset < tasks.length; offset += 200) {
    const { data, error } = await getSupabase().from('items').select('id,marketplace_item_id,marketplace,marketplace_url')
      .in('id', tasks.slice(offset, offset + 200).map(task => task.id));
    if (error) throw error;
    for (const row of data ?? []) ids.set(row.id, row);
  }
  return tasks.map(task => ({ ...task, ...ids.get(task.id) }));
}

export default function PhotoReviewTasks() {
  const { ask, pending, confirmation } = useTaskConfirmation();
  const notice = adminTaskNotice();
  const noticeHandled = useRef(false);
  const [noticeMessage, setNoticeMessage] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [listingTasks, setListingTasks] = useState<ListingTask[]>([]);
  const [items, setItems] = useState<Record<string, Item>>({});
  const [selected, setSelected] = useState<Review | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [photoError,setPhotoError]=useState('');
  const [busy, setBusy] = useState(false);
  const [rejecting,setRejecting]=useState(false);
  const returnRequest=useRef('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saveFiles, setSaveFiles] = useState<File[]>([]);
  const [preparingSave, setPreparingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveRevision, setSaveRevision] = useState(0);

  useEffect(() => {
    let active = true, reading = false, lastRead = -Infinity;
    const refresh = async () => {
      if (reading || document.visibilityState === 'hidden') return;
      reading = true; lastRead = Date.now();
      try {
      const [rows,nextListingTasks] = await Promise.all([
        readResourceSnapshot<Review & {id:string;item:Item}>('photo_reviews'),
        readResourceSnapshot<ListingTask>('listing_tasks'),
      ]);
      const references = await listingProductIds([...nextListingTasks, ...rows.map(row => ({...row.item, id:row.item_id, sales_channel:row.item.sales_channel??''}))]);
      const byReference = new Map(references.map(row => [row.id,row]));
      const detailedListingTasks = nextListingTasks.map(row => ({...row,...byReference.get(row.id)}));
      const byId:Record<string,Item>=Object.fromEntries(rows.map(row=>[row.item_id,{...row.item,...byReference.get(row.item_id)}]));

      if (active) {
        setReviews([...rows].sort((a,b)=>b.submitted_at.localeCompare(a.submitted_at))); setListingTasks(detailedListingTasks); setItems(byId); setError('');
        if (!noticeHandled.current && notice?.kind === 'photo_review') {
          noticeHandled.current = true;
          const target = rows.find(row => row.item_id === notice.itemId);
          if (target) setSelected(target);
          else setNoticeMessage('通知の写真確認タスクはすでに完了したか、現在は確認できません。');
        }
      }
      } catch(cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { reading = false; }
    };
    const visible = () => { if (Date.now() - lastRead >= 30000) void refresh(); };
    void refresh(); const timer = window.setInterval(visible, 300000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [revision]);

  useEffect(() => {
    setPhotos([]);setSaveFiles([]);setSaveMessage('');
    if (!selected) return;
    const controller = new AbortController();
    let active = true;
    setLoadingPhotos(true);setPreparingSave(true);setError('');setPhotoError('');
    (async () => {
      const result = await readReviewPhotos(selected.item_id);
      if (!active) return;
      setPhotos(result.photos);setLoadingPhotos(false);
      try {
        const files = await preparePhotoFiles(result.lotPhotos, result.lotSeq, controller.signal);
        if (active) {
          setSaveFiles(files);
          setSaveMessage(files.length ? '通番号'+result.lotSeq+'の写真'+files.length+'枚をまとめて保存できます。' : '保存できる写真がありません。');
        }
      } catch(cause) {if(active)setSaveMessage(cause instanceof Error?cause.message:String(cause));}
    })().catch(cause => { if (active) setPhotoError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) {setLoadingPhotos(false);setPreparingSave(false);} });
    return () => { active = false; controller.abort(); };
  }, [selected, saveRevision]);

  async function savePhotos() {
    if (!selected || saving || preparingSave) return;
    if (!saveFiles.length) { setSaveRevision(value => value + 1); return; }
    setSaving(true);
    try {
      // No network awaits here: the prepared files preserve the click activation.
      const result = await savePhotoFiles(saveFiles, `通番号${items[selected.item_id]?.lot_seq} 商品写真`);
      setSaveMessage(result === 'share'
        ? '共有メニューで「画像を保存」または「写真に保存」を選んでください。'
        : `${saveFiles.length}枚をダウンロードしました。端末の写真アプリに保存してください。`);
    } catch (cause) {
      setSaveMessage(cause instanceof DOMException && cause.name === 'AbortError'
        ? '保存をキャンセルしました。' : cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  }

  async function approve() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      const { error: approveError } = await getSupabase().rpc('approve_photo_review', { p_item_id: selected.item_id });
      if (approveError) throw approveError;
      setSelected(null); setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function reject(reason:string){
    if(!selected)return;
    const {error:rejectError}=await getSupabase().rpc('reject_photo_review',{p_item_id:selected.item_id,p_submitted_at:selected.submitted_at,p_reason:reason,p_request_id:returnRequest.current});
    if(rejectError)throw rejectError;
    setRejecting(false);setSelected(null);setRevision(value=>value+1);
  }

  async function completeListing(task: ListingTask) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const { error: updateError } = await getSupabase().from('items')
        .update({ status: '出品中' })
        .eq('id', task.id).eq('status','商品登録前').is('sold_on',null);
      if (updateError) throw updateError;
      setListingTasks(current => current.filter(row => row.id !== task.id));
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <>
      {noticeMessage && <li role="status">{noticeMessage}</li>}
      {listingTasks.map(task => { const sourceUrl=purchaseItemUrl(task.marketplace??null,task.marketplace_item_id??null,task.marketplace_url??null); return <li key={`listing-${task.id}`} className="malfunction-task-row admin-task-card admin-simple-task">
        <div className="task-action-details listing-task-details"><strong>{task.sales_channel}出品</strong> <a className="listing-inventory-link" href={deliveryAppUrl+'?itemId='+encodeURIComponent(task.id)} target="_blank" rel="noopener noreferrer" aria-label="出品する商品の在庫を開く">【{productSerial(task.sku,task.lot_seq)}】</a> {sourceUrl?<a href={sourceUrl} target="_blank" rel="noopener noreferrer">【{task.marketplace_item_id || '商品ID未登録'}】</a>:<span>【{task.marketplace_item_id || '商品ID未登録'}】</span>}<small>{task.sku}</small></div>
        <button type="button" className="btn" disabled={busy || pending} onClick={() => ask(task.sales_channel+'出品：完了', () => completeListing(task))}>完了</button>
      </li>;})}
      {reviews.map(review => { const item=items[review.item_id]; const sourceUrl=purchaseItemUrl(item?.marketplace??null,item?.marketplace_item_id??null,item?.marketplace_url??null); return <li key={review.item_id} className="admin-task-card admin-simple-task admin-photo-task">
        <div className="task-action-details"><strong>写真確認{item?.sales_channel&&<span style={{fontWeight:400}}>（{item.sales_channel}販売用）</span>}</strong><a href={deliveryAppUrl+'?itemId='+encodeURIComponent(review.item_id)} target="_blank" rel="noopener noreferrer">【{item?productSerial(item.sku,item.lot_seq):'通番号確認中'}】</a>{sourceUrl?<a href={sourceUrl} target="_blank" rel="noopener noreferrer">【{item?.marketplace_item_id||'商品ID未登録'}】</a>:<span>【{item?.marketplace_item_id||'商品ID未登録'}】</span>}<small>{item?.sku||'SKU確認中'}</small></div>
        <span className="admin-photo-count">写真 {review.exported_photo_count}枚</span><button type="button" className="btn" onClick={() => setSelected(review)}>確認</button>
      </li>;})}
    {rejecting&&selected&&<ReturnReasonDialog label="写真確認：NG（差し戻し）" onSubmit={reject} onCancel={()=>setRejecting(false)}/> }
    {confirmation}
    {error && <li className="error" role="alert">写真確認タスクを読み込めませんでした：{error}<button className="btn" onClick={() => setRevision(value => value + 1)}>再読み込み</button></li>}
    {selected && createPortal(<div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="写真確認">
      <div className="card inventory-comment-panel photo-review-panel">
        <div className="toolbar"><h3>{items[selected.item_id]?.sku} の写真確認</h3><span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || saving} onClick={() => setSelected(null)}>閉じる</button></div>
        <p><a href={`https://drive.google.com/drive/folders/${encodeURIComponent(selected.drive_folder_id)}`} target="_blank" rel="noreferrer">Googleドライブの通番号フォルダを開く</a></p>
        {loadingPhotos ? <p>写真を読み込み中…</p> : <div className="photo-review-gallery">{photos.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={index}><img src={url} alt={`商品写真 ${index + 1}`} /></a>)}</div>}
        {photoError&&<p className="error" role="alert">{photoError}</p>}
        {!loadingPhotos && !photoError && <p className="sub">アプリ保存 {photos.length}枚 ／ Google Drive送信済み {selected.exported_photo_count}枚</p>}
        {!loadingPhotos && !photoError && photos.length !== selected.exported_photo_count && <div className="error" role="status">写真枚数が一致しないため完了できません。納品アプリで「Googleドライブ追加」を再実行して、追加分も送信してください。</div>}
        <div className="photo-review-actions">
          <button type="button" className="btn primary photo-review-icon" aria-label="写真確認を完了" title="写真確認を完了" disabled={busy || saving || loadingPhotos || !!photoError || photos.length===0 || photos.length !== selected.exported_photo_count} onClick={() => void approve()}>{busy ? '処理中…' : 'OK'}</button>
          <button type="button" className="btn photo-review-icon" aria-label="写真確認を差し戻す" disabled={busy||saving||loadingPhotos} onClick={()=>{returnRequest.current=crypto.randomUUID();setRejecting(true);}}>NG</button>
          <button type="button" className="btn photo-review-icon" aria-label="通番号の写真をすべて保存" title={preparingSave ? '写真を準備中' : '通番号の写真をすべて保存'} disabled={busy || saving || preparingSave} onClick={() => void savePhotos()}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></svg>
          </button>
        </div>
        <p className="sub" role="status">{preparingSave ? '保存する写真を準備中…' : saving ? '写真の保存メニューを開いています…' : saveMessage}</p>
        <p className="sub">スマホでは保存ボタンを押し、共有メニューの「画像を保存」または「写真に保存」を選んでください。</p>
      </div>
    </div>, document.body)}
  </>;
}
