import ColoredLabel from '../components/ColoredLabel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { jpDate, canViewDeliveryAssignee, canAddPackingPhotos } from '@bussan/shared';
import type { DeliveryTask, ItemComment, Staff } from '@bussan/shared';
import {
  addPhotosToDrive, deletePhoto, fetchComments, fetchSupplierConversation, fetchSupplierOperation, fetchPhotoReview, fetchPhotoUrls, fetchTask, postComment,
  queueSupplierOperation, recordListingPhotoUpload, uploadPhoto,
} from '../api';
import type { ItemPhoto, MarketplaceConversation, PhotoReviewState } from '../api';
import DescriptionEditor from '../components/DescriptionEditor';


export default function TaskDetail({
  itemId, latestTask, staff, listingSkus, mode = 'photos', onClose, onChanged, onOpened,
}: { mode?: 'photos'|'packingPhotos'|'description'|'messages'|'comments'; itemId: string; latestTask?: DeliveryTask; staff: Staff; listingSkus: string[]; onClose: () => void; onChanged: (task: DeliveryTask) => void; onOpened: (itemId: string) => void }) {
  const packing=mode==='packingPhotos';
  const photoMode=mode==='photos'||packing;
  const purpose=packing?'packing':'product';
  const [task, setTask] = useState<DeliveryTask | null>(null);
  const openedReported = useRef(false);
  const [supplierAccount,setSupplierAccount]=useState('');
  const supplierRequest=useRef(crypto.randomUUID());
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const autoOpenedMessages = useRef(false);
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [photos, setPhotos] = useState<ItemPhoto[]>([]);
  const [photoReview, setPhotoReview] = useState<PhotoReviewState | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMessage, setDriveMessage] = useState('');
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null);
  const [savingPhotoId, setSavingPhotoId] = useState<string | null>(null);
  const [photoSaveMessage, setPhotoSaveMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [marketplaceConversation, setMarketplaceConversation] = useState<MarketplaceConversation>({ messages: [], outbox: [] });
  const [marketplaceVisible, setMarketplaceVisible] = useState(false);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceDraft, setMarketplaceDraft] = useState('');
  const [marketplaceSending, setMarketplaceSending] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState('');

  const reload = useCallback(async () => {
    try {
      const [t, c, p, review] = await Promise.all([
        fetchTask(itemId, canViewDeliveryAssignee(staff)), mode === 'messages'||mode === 'comments' ? fetchComments(itemId) : Promise.resolve([]), photoMode ? fetchPhotoUrls(itemId,purpose) : Promise.resolve([]), mode === 'photos' ? fetchPhotoReview(itemId) : Promise.resolve(null),
      ]);
      if (!t) throw new Error('商品が見つかりません。');
      setTask(t);
      onChanged(t);
      setComments(c);
      setPhotos(p);
      setPhotoReview(review);
      if (!openedReported.current) { openedReported.current = true; onOpened(itemId); }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [itemId, onChanged, onOpened, staff.code, staff.role, mode]);

  useEffect(() => { void reload(); }, [reload]);
  const detailRevision = useRef(latestTask?.detail_revision);
  // Keep catalog/item data current without remounting the editor or resetting drafts.
  useEffect(() => {
    if (latestTask) setTask(current => current ? {
      ...current,...latestTask,
      ...(latestTask.summary_only?{description:current.description,malfunction_comment:current.malfunction_comment}:{}),
    } : current);
    if(latestTask?.detail_revision && latestTask.detail_revision!==detailRevision.current){
      detailRevision.current=latestTask.detail_revision;
      void reload();
    }
  }, [latestTask, reload]);



  async function displayMarketplaceMessages() {
    if (!task || marketplaceLoading) return;
    setMarketplaceVisible(true); setMarketplaceLoading(true); setMarketplaceError('');
    try {
      const current = await fetchSupplierConversation(itemId); setMarketplaceConversation(current);
      if(current.account_id&&!supplierAccount)setSupplierAccount(current.account_id);
      if (current.expired) { setMarketplaceError('梱包完了から7日を過ぎたため、取引メッセージは保存期間終了です。'); return; }

      const supplierRequestId=await queueSupplierOperation(itemId,'read',supplierAccount||current.account_id||'',supplierRequest.current);supplierRequest.current=crypto.randomUUID();
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
       await new Promise(resolve=>window.setTimeout(resolve,4000));
       if(!mounted.current)return;
       if(document.visibilityState==='hidden')continue;
       const updated=await fetchSupplierOperation(supplierRequestId);
       if(updated.status==='succeeded'||updated.status==='failed'){
        setMarketplaceConversation(await fetchSupplierConversation(itemId));if(updated.status==='failed')setMarketplaceError(updated.note||'取引メッセージを確認できませんでした');return;
       }
      }
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
  async function onPhotoPick(files: FileList | null) {
    if (!files || !task) return;
    setUploading(true);
    setError(null);
    let uploadedCount = 0;
    try {
      for (const file of Array.from(files)) {
        await uploadPhoto(task.sku, task.id, staff.id, file,purpose);
        uploadedCount++;
      }
      setDriveMessage('新しい写真があります。Googleドライブ追加してください。');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(/Failed to fetch|NetworkError|Load failed/i.test(message)
        ? '写真をSupabaseへ送信できませんでした。通信状態を確認し、安定したWi‑Fiまたはモバイル通信で再度お試しください。'
        : message);
    } finally {
      // Reflect successfully saved photos even if a later progress update failed.
      if (uploadedCount > 0) {
        try { if (!packing && !task.photo_uploaded) await recordListingPhotoUpload(task.id); }
        catch (cause) { setError(current => current ?? (cause instanceof Error ? cause.message : String(cause))); }
        await reload();
      }
      setUploading(false);
    }
  }
  async function addToDrive() {
    if (!task) return;
    setDriveBusy(true); setError(null); setDriveMessage('');
    try {
      const result = await addPhotosToDrive(task.id,purpose);
      setDriveMessage(packing?`梱包写真${result.total}枚を商品写真と同じ保存先に追加しました。`:`${result.total}枚を通番号${task.lot_seq}の共通フォルダに保存しました。管理アプリで写真確認を待っています。`);
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
      setDriveMessage(packing?'梱包写真を削除しました。':'写真を削除しました。残りの写真は「Googleドライブ追加」から確認へ再提出してください。');
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
      const requestId = await queueSupplierOperation(task.id,'send',supplierAccount,supplierRequest.current,marketplaceDraft.trim());
      setMarketplaceDraft('');supplierRequest.current=crypto.randomUUID();
      const deadline = Date.now() + 120000;
      while(Date.now()<deadline){
       if(!mounted.current)return;
       if(document.visibilityState==='hidden'){await new Promise(resolve=>window.setTimeout(resolve,4000));continue;}
       const state=await fetchSupplierOperation(requestId);
       if(['succeeded','failed','uncertain'].includes(state.status)){
        setMarketplaceConversation(await fetchSupplierConversation(itemId));if(state.status!=='succeeded')setMarketplaceError(state.note||'送信結果を確認してください');return;
       }
       await new Promise(resolve=>window.setTimeout(resolve,4000));
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

  const supplierAccounts=task.marketplace==='メルカリ'?[['mercari-1','メルカリ1'],['mercari-2','メルカリ2']]:task.marketplace==='ヤフオク'?[['auctions-1','ヤフオク1'],['auctions-2','ヤフオク2']]:task.marketplace==='ラクマ'?[['rakuma-1','ラクマ1']]:[['flea-1','Yahoo!フリマ1'],['flea-2','Yahoo!フリマ2']];
  const canEditPhotos=packing?canAddPackingPhotos(task):task.status==='商品登録前';
  const isWorkingAmazonReturn = task.marketplace === '動作品Amazon返品';

  return (
    <section className="task-detail-inline" aria-label={`${task.sku}の詳細`}>
      <div className="row inline-detail-header">
        <button type="button" className="btn ghost" onClick={onClose}>詳細を閉じる</button>
        <span className="badge">{task.status}</span>

      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {photoMode && <>
      <div className="card photo-control-row">
        <span className="muted">{packing?'梱包写真':'写真'} {photos.length}枚</span>
        {canEditPhotos&&<label className="btn photo-upload">{uploading ? '追加中…' : packing?'梱包写真追加':'写真追加'}
          <input type="file" aria-label={packing?'梱包写真追加':'商品写真追加'} accept="image/*" multiple disabled={uploading || deletingPhotoId !== null} onChange={e => { void onPhotoPick(e.target.files); e.target.value = ''; }} />
        </label>}
        {canEditPhotos&&<button type="button" className="btn" disabled={driveBusy || uploading || deletingPhotoId !== null || photos.length === 0}
          onClick={() => void addToDrive()}>{driveBusy ? 'Googleドライブ追加中…' : 'Googleドライブ追加'}</button>}
        <button type="button" className="btn photo-save-all" aria-label="商品写真をすべて端末に保存" title="すべての写真を端末に保存" disabled={savingPhotoId !== null || photos.length === 0 || driveBusy || uploading} onClick={() => void saveAllPhotosToAlbum()}>
          {savingPhotoId === 'all' ? '…' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>}
        </button>
      </div>
      {driveMessage && <p className="ok" role="status">{driveMessage}</p>}
      {photoSaveMessage && <p className="muted" role="status">{photoSaveMessage}</p>}
      <div className="product-photos">
        {photos.length > 0 && <div className="photos">{photos.map((photo, index) => <div className="uploaded-photo" key={photo.id}>
          <a href={photo.url} target="_blank" rel="noreferrer">
            <img src={photo.url} alt={`登録した${packing?'梱包写真':'商品写真'} ${index + 1}`} loading="lazy" />
          </a>
                    <div className="uploaded-photo-actions">{canEditPhotos&&<button type="button" className="btn danger photo-delete" aria-label={`写真${index + 1}を削除`} disabled={photo.canDelete === false || deletingPhotoId !== null || uploading || driveBusy || savingPhotoId !== null} onClick={() => void removePhoto(photo)}>
              {deletingPhotoId === photo.id ? '削除中…' : '削除'}
            </button>}
          </div>
        </div>)}</div>}
      </div>
      {!packing && !isWorkingAmazonReturn && photoReview && <p className={photoReview.approved_at ? 'ok' : 'muted'}>
        写真確認：{photoReview.approved_at ? '完了' : '確認待ち'}
      </p>}

      </>}
      {mode === 'description' && task.status==='商品登録前' && <DescriptionEditor key={task.id} task={task} listingSkus={listingSkus} onSaved={reload} />}
      {(mode === 'messages'||mode === 'comments') && <>
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

      {mode === 'messages' && <div className="card marketplace-conversation" aria-label="フリマサイト取引メッセージ">
        <div className="marketplace-conversation-heading"><strong>取引メッセージ</strong><span className="muted"><ColoredLabel value={task.marketplace} /> · {task.marketplace_item_id || '取引IDなし'}</span></div>
        <label>購入アカウント<select aria-label="仕入先の購入アカウント" value={supplierAccount} onChange={event=>setSupplierAccount(event.target.value)}><option value="">選択</option>{supplierAccounts.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
        {!task.marketplace_item_id ? <p className="muted">商品IDが登録されていないため、取引メッセージを連携できません。</p> : <>
          <button type="button" className="btn" disabled={marketplaceLoading} onClick={() => void displayMarketplaceMessages()}>{marketplaceLoading ? '確認中…' : 'メッセージを取得'}</button>
          {marketplaceError && <p className="error" role="alert">{marketplaceError}</p>}
          {marketplaceVisible && <>
            <div className="marketplace-message-list" aria-live="polite">
              {marketplaceConversation.messages.length === 0 && <p className="muted">取引メッセージはまだ取得されていません。</p>}
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
      </div>}
      </>}
    </section>
  );
}
