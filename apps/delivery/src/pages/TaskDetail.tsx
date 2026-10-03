import { useCallback, useEffect, useState } from 'react';
import { WORK_STEPS, jpDate } from '@bussan/shared';
import type { DeliveryTask, ItemComment, Staff, WorkStep } from '@bussan/shared';
import {
  addPhotosToDrive, deletePhoto, fetchComments, fetchPhotoReview, fetchPhotoReviewPolicy, fetchPhotoUrls, fetchTask, postComment,
  reportItemMalfunction, setDeliveryProgress, setWorkProgress, uploadPhoto,
} from '../api';
import type { ItemPhoto, PhotoReviewState } from '../api';
import DescriptionEditor from '../components/DescriptionEditor';

function isStepDone(task: DeliveryTask, step: WorkStep): boolean {
  switch (step) {
    case 'inspection_cleaning': return task.inspected && task.cleaned;
    case 'arrived':    return task.arrived_on !== null;
    case 'registered': return task.product_registered;
    case 'inspected':  return task.inspected;
    case 'cleaned':    return task.cleaned;
    case 'listing':    return task.product_registered && (task.marketplace === '動作品Amazon返品' || task.photo_uploaded);
    case 'photo':      return task.photo_uploaded;
    case 'packed':     return task.packed_on !== null;
    case 'shipped':    return task.shipped_on !== null;
  }
}

export default function TaskDetail({
  itemId, staff, onClose, onChanged,
}: { itemId: string; staff: Staff; onClose: () => void; onChanged: (task: DeliveryTask) => void }) {
  const [task, setTask] = useState<DeliveryTask | null>(null);
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [photos, setPhotos] = useState<ItemPhoto[]>([]);
  const [photoReview, setPhotoReview] = useState<PhotoReviewState | null>(null);
  const [reviewEnforced, setReviewEnforced] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<WorkStep | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [malfunctionChecked, setMalfunctionChecked] = useState(false);
  const [malfunctionComment, setMalfunctionComment] = useState('');
  const [malfunctionBusy, setMalfunctionBusy] = useState(false);
  const isDeliveryMaster = staff.role === 'admin' && staff.name === '長部一輝';

  const reload = useCallback(async () => {
    try {
      const [t, c, p, review, enforced] = await Promise.all([
        fetchTask(itemId), fetchComments(itemId), fetchPhotoUrls(itemId), fetchPhotoReview(itemId), fetchPhotoReviewPolicy(),
      ]);
      if (!t) throw new Error('商品が見つかりません。');
      setTask(t);
      onChanged(t);
      setComments(c);
      setPhotos(p);
      setPhotoReview(review);
      setReviewEnforced(enforced);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [itemId, onChanged]);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(step: WorkStep) {
    if (!task) return;
    setPending(step);
    setError(null);
    try {
      if (step === 'inspection_cleaning' || step === 'listing' || step === 'packed' || step === 'shipped') {
        const date = step === 'packed' ? task.packed_on : step === 'shipped' ? task.shipped_on : null;
        const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        await setDeliveryProgress(task.id, step, !isStepDone(task, step), date ?? today);
      } else await setWorkProgress(task.id, step, !isStepDone(task, step));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  async function setStepDate(step: 'packed' | 'shipped', date: string) {
    if (!task) return;
    setPending(step); setError(null);
    try { await setDeliveryProgress(task.id, step, !!date, date || undefined); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(null); }
  }

  async function onPhotoPick(files: FileList | null) {
    if (!files || !task) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadPhoto(task.sku, task.id, staff.id, file);
      }
      setDriveMessage('新しい写真があります。Googleドライブに追加してください。');
      // 写真が 1 枚でも入ったら「写真登録」を自動で済みにする
      if (!task.photo_uploaded) await setWorkProgress(task.id, 'photo', true);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function addToDrive() {
    if (!task) return;
    setDriveBusy(true); setError(null); setDriveMessage('');
    try {
      const result = await addPhotosToDrive(task.id);
      setDriveMessage(`${result.total}枚をSKUフォルダに保存しました。管理アプリで写真確認を待っています。`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDriveBusy(false); }
  }

  async function removePhoto(photo: ItemPhoto) {
    if (!window.confirm('この写真をアプリとGoogleドライブから削除します。よろしいですか？')) return;
    setDeletingPhotoId(photo.id); setError(null); setDriveMessage('');
    try {
      await deletePhoto(photo.id);
      setDriveMessage('写真を削除しました。残りの写真は「Googleドライブに追加」から確認へ再提出してください。');
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeletingPhotoId(null); }
  }

  async function send() {
    if (!task || !draft.trim()) return;
    setError(null);
    try {
      await postComment(task.id, staff.id, draft.trim());
      setDraft('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!task) {
    return (
      <section className="task-detail-inline">
        {error ? <div className="error">{error}</div> : <div className="empty">読み込み中…</div>}
      </section>
    );
  }

  async function reportMalfunction() {
    if (!task || !malfunctionComment.trim()) return;
    setMalfunctionBusy(true); setError(null);
    try {
      await reportItemMalfunction(task.id, malfunctionComment.trim());
      setMalfunctionChecked(false); setMalfunctionComment('');
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setMalfunctionBusy(false); }
  }
  const isWorkingAmazonReturn = task.marketplace === '動作品Amazon返品';

  return (
    <section className="task-detail-inline" aria-label={`${task.sku}の詳細`}>
      <div className="row inline-detail-header">
        <button type="button" className="btn ghost" onClick={onClose}>詳細を閉じる</button>
        <span className="badge">{task.status}</span>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {!isWorkingAmazonReturn && <div className="card row">
        <span className="muted">写真 {photos.length}枚</span>
        <label className="btn photo-upload">{uploading ? '追加中…' : '写真を追加'}
          <input type="file" aria-label="商品写真を追加" accept="image/*" multiple disabled={uploading || pending !== null || deletingPhotoId !== null} onChange={e => { void onPhotoPick(e.target.files); e.target.value = ''; }} />
        </label>
        <button type="button" className="btn" disabled={driveBusy || uploading || deletingPhotoId !== null || photos.length === 0}
          onClick={() => void addToDrive()}>{driveBusy ? 'Googleドライブに追加中…' : 'Googleドライブに追加'}</button>
      </div>}
      {driveMessage && <p className="ok" role="status">{driveMessage}</p>}
      {!isWorkingAmazonReturn && <div className="product-photos">
        {photos.length > 0 && <div className="photos">{photos.map((photo, index) => <div className="uploaded-photo" key={photo.id}>
          <a href={photo.url} target="_blank" rel="noreferrer">
            <img src={photo.url} alt={`登録した商品写真 ${index + 1}`} loading="lazy" />
          </a>
          <button type="button" className="btn danger photo-delete" aria-label={`写真${index + 1}を削除`} disabled={deletingPhotoId !== null || uploading || driveBusy} onClick={() => void removePhoto(photo)}>
            {deletingPhotoId === photo.id ? '削除中…' : '削除'}
          </button>
        </div>)}</div>}
      </div>}
      {!isWorkingAmazonReturn && photoReview && <p className={photoReview.approved_at ? 'ok' : 'muted'}>
        写真確認：{photoReview.approved_at ? '完了' : '確認待ち'}
      </p>}

      {/* ── 作業チェック ─────────────────────────── */}
      <div className="card">
        <strong>作業チェック</strong>
        {task.malfunction_reported && <p className="ok" role="status">動作不良を管理アプリへ報告済み{task.malfunction_resolved_at ? '（対応済み）' : '（対応待ち）'}</p>}
        {!task.malfunction_reported && <div className="malfunction-report">
          <label><input type="checkbox" checked={malfunctionChecked} onChange={e => setMalfunctionChecked(e.target.checked)} disabled={malfunctionBusy} /> 動作不良</label>
          {malfunctionChecked && <><textarea aria-label="動作不良の内容" value={malfunctionComment} onChange={e => setMalfunctionComment(e.target.value)} maxLength={2000} placeholder="動作不良の内容を入力" />
            <button type="button" className="btn primary" disabled={!malfunctionComment.trim() || malfunctionBusy} onClick={() => void reportMalfunction()}>{malfunctionBusy ? '報告中…' : '管理アプリに報告'}</button></>}
        </div>}
        <div className="steps">
          {WORK_STEPS.map((step) => {
            const s = isWorkingAmazonReturn && step.key === 'listing' ? { ...step, label: '商品登録' } : step;
            const done = isStepDone(task, s.key);
            return (
              <div className="step" key={s.key} data-done={done}>
              <button
                className="step-toggle"
                aria-pressed={done} disabled={pending !== null || uploading || (!isDeliveryMaster && reviewEnforced && (s.key === 'packed' || s.key === 'shipped') && !photoReview?.approved_at && !done)} onClick={() => void toggle(s.key)}
              >
                <span className="check">{done ? '✓' : ''}</span>
                <span>
                  <span className="label">{s.label}</span>
                </span>
              </button>
              {(s.key === 'packed' || s.key === 'shipped') &&
                <input className="step-date" aria-label={s.key === 'packed' ? '梱包の日付' : '出荷の日付'}
                  type="date" value={s.key === 'packed' ? task.packed_on ?? '' : task.shipped_on ?? ''} disabled={pending !== null || uploading || (!isDeliveryMaster && reviewEnforced && !photoReview?.approved_at && !done)}
                  onChange={e => void setStepDate(s.key as 'packed' | 'shipped', e.target.value)} />}
              </div>
            );
          })}
        </div>
      </div>
      {!isWorkingAmazonReturn && !isDeliveryMaster && reviewEnforced && !photoReview?.approved_at && <p className="muted">梱包・出荷は管理アプリの写真確認が完了すると入力できます。</p>}

      <DescriptionEditor key={task.id} task={task} onSaved={reload} />

      {/* ── 仕入担当者とのやり取り ───────────────── */}
      <div className="card">
        <strong>コメント</strong>
        {comments.length === 0 && <p className="muted">まだやり取りはありません。</p>}
        {comments.map((c) => (
          <div key={c.id} className={`comment ${c.author_id === staff.id ? 'mine' : ''}`}>
            <div className="meta">{jpDate(c.created_at)} {new Date(c.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>
            {c.body}
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <textarea
            value={draft} placeholder="欠品や破損があればここに書いてください"
            onChange={(e) => setDraft(e.target.value)} style={{ flex: 1 }}
          />
        </div>
        <button className="btn primary" style={{ marginTop: 8 }} disabled={!draft.trim()} onClick={() => void send()}>
          送信
        </button>
      </div>

    </section>
  );
}
