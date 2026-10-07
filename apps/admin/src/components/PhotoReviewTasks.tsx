import { useEffect, useRef, useState } from 'react';
import { adminTaskNotice } from '../taskNotice';
import { createPortal } from 'react-dom';
import { getSupabase, PHOTO_BUCKET } from '@bussan/shared';
import { preparePhotoFiles, savePhotoFiles } from '../photoSave';

interface Review { item_id: string; drive_folder_id: string; submitted_at: string; exported_photo_count: number }
interface Item { id: string; sku: string; title: string; lot_seq: number }

export default function PhotoReviewTasks() {
  const notice = adminTaskNotice();
  const noticeHandled = useRef(false);
  const [noticeMessage, setNoticeMessage] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [items, setItems] = useState<Record<string, Item>>({});
  const [selected, setSelected] = useState<Review | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saveFiles, setSaveFiles] = useState<File[]>([]);
  const [preparingSave, setPreparingSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [saveRevision, setSaveRevision] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: readError } = await getSupabase().from('photo_reviews')
        .select('item_id,drive_folder_id,submitted_at,exported_photo_count')
        .is('approved_at', null).order('submitted_at', { ascending: false });
      if (readError) throw readError;
      const rows = (data ?? []) as Review[];
      let byId: Record<string, Item> = {};
      if (rows.length) {
        const { data: found, error: itemError } = await getSupabase().from('items')
          .select('id,sku,title,lot_seq').in('id', rows.map(row => row.item_id));
        if (itemError) throw itemError;
        byId = Object.fromEntries(((found ?? []) as Item[]).map(item => [item.id, item]));
      }
      if (active) {
        setReviews(rows); setItems(byId); setError('');
        if (!noticeHandled.current && notice?.kind === 'photo_review') {
          noticeHandled.current = true;
          const target = rows.find(row => row.item_id === notice.itemId);
          if (target) setSelected(target);
          else setNoticeMessage('通知の写真確認タスクはすでに完了したか、現在は確認できません。');
        }
      }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [revision]);

  useEffect(() => {
    if (!selected) { setPhotos([]); return; }
    let active = true;
    setLoadingPhotos(true);
    (async () => {
      const { data, error: readError } = await getSupabase().from('item_photos')
        .select('storage_path').eq('item_id', selected.item_id).order('created_at');
      if (readError) throw readError;
      const paths = (data ?? []).map(row => row.storage_path);
      const { data: signed, error: signError } = await getSupabase().storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
      if (signError) throw signError;
      if (active) setPhotos((signed ?? []).map(row => row.signedUrl).filter((url): url is string => !!url));
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoadingPhotos(false); });
    return () => { active = false; };
  }, [selected]);

  useEffect(() => {
    setSaveFiles([]); setSaveMessage('');
    if (!selected) return;
    const controller = new AbortController();
    let active = true;
    setPreparingSave(true);
    (async () => {
      const { data, error: listError } = await getSupabase().functions.invoke('delivery-photo-drive', {
        body: { itemId: selected.item_id, action: 'list' },
      });
      if (listError) throw listError;
      if (!Array.isArray(data?.photos) || typeof data?.lotSeq !== 'number') throw new Error('通番号の写真を取得できませんでした。');
      const files = await preparePhotoFiles(data.photos, data.lotSeq, controller.signal);
      if (active) {
        setSaveFiles(files);
        setSaveMessage(files.length ? `通番号${data.lotSeq}の写真${files.length}枚をまとめて保存できます。` : '保存できる写真がありません。');
      }
    })().catch(cause => { if (active) setSaveMessage(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setPreparingSave(false); });
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

  return <>
      {noticeMessage && <li role="status">{noticeMessage}</li>}
      {reviews.map(review => <li key={`photo-${review.item_id}`}><button onClick={() => setSelected(review)}>
        <span>{items[review.item_id]?.sku || 'SKU確認中'}<small>{items[review.item_id]?.title || ''} ／ 写真 {review.exported_photo_count}枚</small></span>
        <strong>写真確認</strong><span>確認 ›</span>
      </button></li>)}
    {error && <li className="error" role="alert">写真確認タスクを読み込めませんでした：{error}<button className="btn" onClick={() => setRevision(value => value + 1)}>再読み込み</button></li>}
    {selected && createPortal(<div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="写真確認">
      <div className="card inventory-comment-panel photo-review-panel">
        <div className="toolbar"><h3>{items[selected.item_id]?.sku} の写真確認</h3><span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || saving} onClick={() => setSelected(null)}>閉じる</button></div>
        <p><a href={`https://drive.google.com/drive/folders/${encodeURIComponent(selected.drive_folder_id)}`} target="_blank" rel="noreferrer">Googleドライブの通番号フォルダを開く</a></p>
        {loadingPhotos ? <p>写真を読み込み中…</p> : <div className="photo-review-gallery">{photos.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={index}><img src={url} alt={`商品写真 ${index + 1}`} /></a>)}</div>}
        {!loadingPhotos && <p className="sub">アプリ保存 {photos.length}枚 ／ Google Drive送信済み {selected.exported_photo_count}枚</p>}
        {!loadingPhotos && photos.length !== selected.exported_photo_count && <div className="error" role="status">写真枚数が一致しないため完了できません。納品アプリで「Googleドライブ追加」を再実行して、追加分も送信してください。</div>}
        <div className="photo-review-actions">
          <button type="button" className="btn primary photo-review-icon" aria-label="写真確認を完了" title="写真確認を完了" disabled={busy || saving || loadingPhotos || photos.length !== selected.exported_photo_count} onClick={() => void approve()}>{busy ? '…' : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 10v11H3V10h4Zm0 0 5-7a3 3 0 0 1 2 3l-1 4h6a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7" /></svg>}</button>
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
