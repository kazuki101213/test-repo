import ColoredLabel from '../components/ColoredLabel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WORK_STEPS, jpDate, canViewDeliveryAssignee, staffDisplayName } from '@bussan/shared';
import type { DeliveryTask, ItemComment, Staff, WorkStep } from '@bussan/shared';
import {
  addPhotosToDrive, deletePhoto, fetchComments, fetchMarketplaceConversation, fetchPhotoReview, fetchPhotoReviewPolicy, fetchPhotoUrls, fetchTask, postComment,
  queueMarketplaceMessage, requestMarketplaceMessageSync, reportItemMalfunction, setDeliveryProgress, setWorkProgress, uploadPhoto,
} from '../api';
import type { ItemPhoto, MarketplaceConversation, PhotoReviewState } from '../api';
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
  itemId, staff, listingSkus, onClose, onChanged, onOpened,
}: { itemId: string; staff: Staff; listingSkus: string[]; onClose: () => void; onChanged: (task: DeliveryTask) => void; onOpened: (itemId: string) => void }) {
  const [task, setTask] = useState<DeliveryTask | null>(null);
  const openedReported = useRef(false);
  const autoOpenedMessages = useRef(false);
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
  const [savingPhotoId, setSavingPhotoId] = useState<string | null>(null);
  const [photoSaveMessage, setPhotoSaveMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [malfunctionChecked, setMalfunctionChecked] = useState(false);
  const [malfunctionComment, setMalfunctionComment] = useState('');
  const [malfunctionBusy, setMalfunctionBusy] = useState(false);
  const [marketplaceConversation, setMarketplaceConversation] = useState<MarketplaceConversation>({ messages: [], outbox: [] });
  const [marketplaceVisible, setMarketplaceVisible] = useState(false);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceDraft, setMarketplaceDraft] = useState('');
  const [marketplaceSending, setMarketplaceSending] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState('');
  const isDeliveryMaster = staff.role === 'admin' && staff.name === '長部一輝';

  const reload = useCallback(async () => {
    try {
      const [t, c, p, review, enforced] = await Promise.all([
        fetchTask(itemId, canViewDeliveryAssignee(staff)), fetchComments(itemId), fetchPhotoUrls(itemId), fetchPhotoReview(itemId), fetchPhotoReviewPolicy(),
      ]);
      if (!t) throw new Error('商品が見つかりません。');
      setTask(t);
      onChanged(t);
      setComments(c);
      setPhotos(p);
      setPhotoReview(review);
      setReviewEnforced(enforced);
      if (!openedReported.current) { openedReported.current = true; onOpened(itemId); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [itemId, onChanged, onOpened, staff.code, staff.role]);

  useEffect(() => { void reload(); }, [reload]);



  async function displayMarketplaceMessages() {
    if (!task || marketplaceLoading) return;
    if (marketplaceVisible) { setMarketplaceVisible(false); return; }
    setMarketplaceVisible(true); setMarketplaceLoading(true); setMarketplaceError('');
    try {
      const current = await fetchMarketplaceConversation(itemId); setMarketplaceConversation(current);
      if (current.expired) { setMarketplaceError('梱包完了から7日を過ぎたため、取引メッセージは保存期間終了です。'); return; }
      if (!current.first_app_sent_at) { setMarketplaceError('アプリから取引メッセージを送信した後に、相手のメッセージを確認できます。'); return; }
      await requestMarketplaceMessageSync(itemId);
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) { await new Promise(resolve => window.setTimeout(resolve, 4000)); const updated = await fetchMarketplaceConversation(itemId); setMarketplaceConversation(updated); if (updated.sync?.status === 'completed') { if(updated.sync.result_note)setMarketplaceError(updated.sync.result_note); return; } if (updated.sync?.status === 'failed') { setMarketplaceError(updated.sync.result_note || '拡張機能で取引メッセージを確認できませんでした。'); return; } }
      setMarketplaceError('拡張機能の確認待ちです。ログイン済みChromeで拡張機能を起動し、もう一度「メッセージを表示」を押してください。');
    } catch (cause) { setMarketplaceError(cause instanceof Error ? cause.message : String(cause)); } finally { setMarketplaceLoading(false); }
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!task || autoOpenedMessages.current || params.get('itemId') !== itemId || params.get('openMessages') !== '1'
      || staff.role !== 'admin' || staff.name !== '長部一輝') return;
    autoOpenedMessages.current = true;
    const timer = window.setTimeout(() => { void displayMarketplaceMessages(); }, 0);
    return () => window.clearTimeout(timer);
  }, [task, itemId, staff.id, staff.name, staff.role]);
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
    let uploadedCount = 0;
    try {
      for (const file of Array.from(files)) {
        await uploadPhoto(task.sku, task.id, staff.id, file);
        uploadedCount++;
      }
      setDriveMessage('新しい写真があります。Googleドライブ追加してください。');
      if (!task.photo_uploaded) await setWorkProgress(task.id, 'photo', true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(/Failed to fetch|NetworkError|Load failed/i.test(message)
        ? '写真をSupabaseへ送信できませんでした。通信状態を確認し、安定したWi‑Fiまたはモバイル通信で再度お試しください。'
        : message);
    } finally {
      // Reflect successfully saved photos even if a later progress update failed.
      if (uploadedCount > 0) await reload();
      setUploading(false);
    }
  }
  async function addToDrive() {
    if (!task) return;
    setDriveBusy(true); setError(null); setDriveMessage('');
    try {
      const result = await addPhotosToDrive(task.id);
      setDriveMessage(`${result.total}枚を通番号${task.lot_seq}の共通フォルダに保存しました。管理アプリで写真確認を待っています。`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDriveBusy(false); }
  }

  async function saveAllPhotosToAlbum() {
    if (!task || savingPhotoId || photos.length === 0) return;
    setSavingPhotoId('all');
    setPhotoSaveMessage('');
    try {
      const files: File[] = [];
      for (let index = 0; index < photos.length; index++) {
        const photo = photos[index];
        if (!photo) continue;
        const response = await fetch(photo.url);
        if (!response.ok) throw new Error('写真をダウンロードできませんでした。通信状態を確認してください。');
        const blob = await response.blob();
        const safeSku = task.sku.replace(/[^a-zA-Z0-9_-]/g, '_');
        files.push(new File([blob], safeSku + '_photo_' + (index + 1) + '.jpg', { type: blob.type || 'image/jpeg' }));
      }
      if (navigator.share && navigator.canShare?.({ files })) {
        setPhotoSaveMessage('端末の共有メニューから「写真に保存」または「画像を保存」を選んでください。');
        await navigator.share({ files, title: task.sku + ' 商品写真' });
      } else {
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const link = document.createElement('a');
          link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          await new Promise(resolve => window.setTimeout(resolve, 250));
        }
        setPhotoSaveMessage(files.length + '枚をダウンロードしました。端末の写真アプリに保存してください。');
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') setPhotoSaveMessage('保存をキャンセルしました。');
      else setPhotoSaveMessage(cause instanceof Error ? cause.message : String(cause));
    } finally { setSavingPhotoId(null); }
  }

  async function removePhoto(photo: ItemPhoto) {
    if (!window.confirm('この写真をアプリとGoogleドライブから削除します。よろしいですか？')) return;
    setDeletingPhotoId(photo.id); setError(null); setDriveMessage('');
    try {
      await deletePhoto(photo.id);
      setDriveMessage('写真を削除しました。残りの写真は「Googleドライブ追加」から確認へ再提出してください。');
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

  async function sendMarketplaceMessage() {
    if (!task || !marketplaceDraft.trim() || marketplaceSending) return;
    setMarketplaceSending(true);
    setMarketplaceError('');
    try {
      const requestId = await queueMarketplaceMessage(task.id, marketplaceDraft.trim());
      setMarketplaceDraft('');
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const updated = await fetchMarketplaceConversation(task.id);
        setMarketplaceConversation(updated);
        if (updated.expired) {
          setMarketplaceError('梱包完了から7日を過ぎたため、送信結果を確認できません。');
          return;
        }
        const request = updated.outbox.find(row => row.id === requestId);
        if (!request) {
          setMarketplaceError('送信依頼は登録されましたが、結果を読み取れませんでした。再送前に会話を再読み込みしてください。');
          return;
        }
        if (request.status === 'sent') return;
        if (request.status === 'failed' || request.status === 'uncertain') {
          setMarketplaceError(request.result_note || (request.status === 'failed' ? 'フリマサイトへの送信に失敗しました。' : '送信結果を確認できません。フリマサイト上の送信状況を確認してください。'));
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 3000));
      }
      setMarketplaceError('送信依頼は登録されていますが、拡張機能からの結果待ちです。送信状態を再確認してください。');
    } catch (cause) {
      setMarketplaceError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMarketplaceSending(false);
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
      <div className="card photo-control-row">
        <span className="muted">写真 {photos.length}枚</span>
        <label className="btn photo-upload">{uploading ? '追加中…' : '写真追加'}
          <input type="file" aria-label="商品写真追加" accept="image/*" multiple disabled={uploading || pending !== null || deletingPhotoId !== null} onChange={e => { void onPhotoPick(e.target.files); e.target.value = ''; }} />
        </label>
        <button type="button" className="btn" disabled={driveBusy || uploading || deletingPhotoId !== null || photos.length === 0}
          onClick={() => void addToDrive()}>{driveBusy ? 'Googleドライブ追加中…' : 'Googleドライブ追加'}</button>
        <button type="button" className="btn photo-save-all" aria-label="商品写真をすべて端末に保存" title="すべての写真を端末に保存" disabled={savingPhotoId !== null || photos.length === 0 || driveBusy || uploading} onClick={() => void saveAllPhotosToAlbum()}>
          {savingPhotoId === 'all' ? '…' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>}
        </button>
      </div>
      {driveMessage && <p className="ok" role="status">{driveMessage}</p>}
      {photoSaveMessage && <p className="muted" role="status">{photoSaveMessage}</p>}
      <div className="product-photos">
        {photos.length > 0 && <div className="photos">{photos.map((photo, index) => <div className="uploaded-photo" key={photo.id}>
          <a href={photo.url} target="_blank" rel="noreferrer">
            <img src={photo.url} alt={`登録した商品写真 ${index + 1}`} loading="lazy" />
          </a>
                    <div className="uploaded-photo-actions"><button type="button" className="btn danger photo-delete" aria-label={`写真${index + 1}を削除`} disabled={photo.canDelete === false || deletingPhotoId !== null || uploading || driveBusy || savingPhotoId !== null} onClick={() => void removePhoto(photo)}>
              {deletingPhotoId === photo.id ? '削除中…' : '削除'}
            </button>
          </div>
        </div>)}</div>}
      </div>
      {!isWorkingAmazonReturn && photoReview && <p className={photoReview.approved_at ? 'ok' : 'muted'}>
        写真確認：{photoReview.approved_at ? '完了' : '確認待ち'}
      </p>}

      {/* ── 作業チェック ─────────────────────────── */}
      <div className="card">
        <strong>作業チェック</strong>
        <div className="steps">
          <div className="malfunction-step-wrap">
            <div className="step" data-done={task.malfunction_reported || malfunctionChecked}>
              <button type="button" className="step-toggle" aria-pressed={task.malfunction_reported || malfunctionChecked}
                disabled={malfunctionBusy || task.malfunction_reported}
                onClick={() => setMalfunctionChecked(checked => !checked)}>
                <span className="check">{task.malfunction_reported || malfunctionChecked ? '✓' : ''}</span>
                <span><span className="label">動作不良</span><br />
                  <span className="hint">{task.malfunction_reported
                    ? `仕入担当者（${staffDisplayName(task.purchaser_name) || '未設定'}）へ報告済み`
                    : '不具合がある場合に選択して、仕入担当者へ報告します'}</span>
                </span>
              </button>
            </div>
            {task.malfunction_reported
              ? <p className="muted malfunction-status" role="status">{task.malfunction_resolved_at ? '動作不良の報告は対応完了です。' : '仕入担当者への報告は対応待ちです。'}{task.malfunction_comment ? ` 内容：${task.malfunction_comment}` : ''}</p>
              : malfunctionChecked && <div className="malfunction-report">
                <textarea aria-label="動作不良の内容" value={malfunctionComment} onChange={e => setMalfunctionComment(e.target.value)} maxLength={2000} placeholder="動作不良の内容を入力" />
                <button type="button" className="btn primary" disabled={!malfunctionComment.trim() || malfunctionBusy} onClick={() => void reportMalfunction()}>{malfunctionBusy ? '報告中…' : '仕入担当者に報告'}</button>
              </div>}
          </div>
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

      <DescriptionEditor key={task.id} task={task} listingSkus={listingSkus} onSaved={reload} />

      {/* ── 仕入担当者とのやり取り ───────────────── */}
      <div className="card">
        <strong>コメント</strong>
        {comments.length === 0 && <p className="muted">まだやり取りはありません。</p>}
        {comments.map((c) => (
          <div key={c.id} className={`comment ${c.author_id === staff.id ? 'mine' : ''}`}>
            <div className="meta">{jpDate(c.created_at)} {new Date(c.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>
            <p style={{whiteSpace: 'pre-wrap', margin: '4px 0'}}>{c.body}</p>
            {c.photos?.length ? <div className="malfunction-comment-photos">{c.photos.map((photo, index) => <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer"><img src={photo.url} alt={'返信写真 ' + (index + 1)} loading="lazy" /></a>)}</div> : null}
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

      <div className="card marketplace-conversation" aria-label="フリマサイト取引メッセージ">
        <div className="marketplace-conversation-heading"><strong>取引メッセージ</strong><span className="muted"><ColoredLabel value={task.marketplace} /> · {task.marketplace_item_id || '取引IDなし'}</span></div>
        {!task.marketplace_item_id ? <p className="muted">商品IDが登録されていないため、取引メッセージを連携できません。</p> : <>
          <button type="button" className="btn" disabled={marketplaceLoading} onClick={() => void displayMarketplaceMessages()}>{marketplaceLoading ? '確認中…' : marketplaceVisible ? 'メッセージを閉じる' : 'メッセージを表示'}</button>
          {marketplaceError && <p className="error" role="alert">{marketplaceError}</p>}
          {marketplaceVisible && <>
            <div className="marketplace-message-list" aria-live="polite">
              {marketplaceConversation.messages.length === 0 && <p className="muted">アプリから送信した後の相手メッセージはありません。</p>}
              {marketplaceConversation.messages.map(message => <article key={message.id} className="marketplace-message" data-author={message.author_role}>
                <div className="meta">{message.author || (message.author_role === 'self' ? '自分' : '取引相手')}{message.sent_at ? ' · ' + new Date(message.sent_at).toLocaleString('ja-JP') : ''}</div><p>{message.body}</p>
              </article>)}
              {marketplaceConversation.outbox.map(request => <article key={request.id} className="marketplace-message" data-author="self" data-status={request.status}>
                <div className="meta">{({ queued: '拡張機能の送信待ち', sending: 'サイトへ送信中', sent: '送信済み', failed: '送信失敗', uncertain: '送信結果を要確認' } as const)[request.status]}{request.sent_at ? ' · ' + new Date(request.sent_at).toLocaleString('ja-JP') : ''}</div><p>{request.body}</p>{request.result_note && <small>{request.result_note}</small>}
              </article>)}
            </div>
            {marketplaceConversation.expired ? <p className="muted">梱包完了から7日を経過したため、会話の保存期間は終了しました。</p> : <div className="marketplace-message-composer">
              <textarea aria-label="フリマ取引相手へのメッセージ" value={marketplaceDraft} onChange={event => setMarketplaceDraft(event.target.value)} maxLength={2000} placeholder="取引相手へのメッセージ" />
              <button type="button" className="btn primary" disabled={!marketplaceDraft.trim() || marketplaceSending} onClick={() => void sendMarketplaceMessage()}>{marketplaceSending ? '送信結果を確認中…' : '取引メッセージを送信'}</button>
              <small className="muted">送信後は、ログイン済みChromeの拡張機能が取引画面へ反映します。</small>
            </div>}
          </>}
        </>}
      </div>

    </section>
  );
}
