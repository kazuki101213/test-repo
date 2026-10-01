import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSupabase, PHOTO_BUCKET } from '@bussan/shared';

interface Review { item_id: string; drive_folder_id: string; submitted_at: string; exported_photo_count: number }
interface Item { id: string; sku: string; title: string }

export default function PhotoReviewTasks() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [items, setItems] = useState<Record<string, Item>>({});
  const [selected, setSelected] = useState<Review | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

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
          .select('id,sku,title').in('id', rows.map(row => row.item_id));
        if (itemError) throw itemError;
        byId = Object.fromEntries(((found ?? []) as Item[]).map(item => [item.id, item]));
      }
      if (active) { setReviews(rows); setItems(byId); setError(''); }
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
      {reviews.map(review => <li key={`photo-${review.item_id}`}><button onClick={() => setSelected(review)}>
        <span>{items[review.item_id]?.sku || 'SKU確認中'}<small>{items[review.item_id]?.title || ''} ／ 写真 {review.exported_photo_count}枚</small></span>
        <strong>写真確認</strong><span>確認 ›</span>
      </button></li>)}
    {error && <li className="error" role="alert">写真確認タスクを読み込めませんでした：{error}<button className="btn" onClick={() => setRevision(value => value + 1)}>再読み込み</button></li>}
    {selected && createPortal(<div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="写真確認">
      <div className="card inventory-comment-panel photo-review-panel">
        <div className="toolbar"><h3>{items[selected.item_id]?.sku} の写真確認</h3><span style={{ flex: 1 }} />
          <button className="btn" disabled={busy} onClick={() => setSelected(null)}>閉じる</button></div>
        <p><a href={`https://drive.google.com/drive/folders/${encodeURIComponent(selected.drive_folder_id)}`} target="_blank" rel="noreferrer">GoogleドライブのSKUフォルダを開く</a></p>
        {loadingPhotos ? <p>写真を読み込み中…</p> : <div className="photo-review-gallery">{photos.map((url, index) => <a href={url} target="_blank" rel="noreferrer" key={index}><img src={url} alt={`商品写真 ${index + 1}`} /></a>)}</div>}
        <button className="btn primary" disabled={busy || loadingPhotos || photos.length !== selected.exported_photo_count} onClick={() => void approve()}>{busy ? '確認中…' : '写真確認を完了'}</button>
      </div>
    </div>, document.body)}
  </>;
}
