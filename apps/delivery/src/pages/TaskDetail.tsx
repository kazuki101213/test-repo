import { useCallback, useEffect, useState } from 'react';
import { CONDITIONS, WORK_STEPS, jpDate, yen } from '@bussan/shared';
import type { DeliveryTask, ItemComment, ItemCondition, Staff, WorkStep } from '@bussan/shared';
import {
  fetchComments, fetchPhotoUrls, fetchTask, postComment,
  setWorkProgress, updateDeliveryFields, uploadPhoto,
} from '../api';

function isStepDone(task: DeliveryTask, step: WorkStep): boolean {
  switch (step) {
    case 'arrived':    return task.arrived_on !== null;
    case 'registered': return task.product_registered;
    case 'inspected':  return task.inspected;
    case 'photo':      return task.photo_uploaded;
    case 'packed':     return task.packed_on !== null;
    case 'shipped':    return task.shipped_on !== null;
  }
}

export default function TaskDetail({
  itemId, staff, onBack,
}: { itemId: string; staff: Staff; onBack: () => void }) {
  const [task, setTask] = useState<DeliveryTask | null>(null);
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<WorkStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [t, c, p] = await Promise.all([
        fetchTask(itemId), fetchComments(itemId), fetchPhotoUrls(itemId),
      ]);
      setTask(t);
      setComments(c);
      setPhotos(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [itemId]);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(step: WorkStep) {
    if (!task) return;
    setPending(step);
    setError(null);
    try {
      await setWorkProgress(task.id, step, !isStepDone(task, step));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  async function onPhotoPick(files: FileList | null) {
    if (!files || !task) return;
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadPhoto(task.sku, task.id, staff.id, file);
      }
      // 写真が 1 枚でも入ったら「写真登録」を自動で済みにする
      if (!task.photo_uploaded) await setWorkProgress(task.id, 'photo', true);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveField(patch: { condition?: ItemCondition; accessories?: string; tracking_no?: string }) {
    if (!task) return;
    setError(null);
    try {
      await updateDeliveryFields(task.id, patch);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
      <div className="app">
        <div className="topbar"><button className="btn ghost" onClick={onBack}>← 戻る</button></div>
        {error ? <div className="error">{error}</div> : <div className="empty">読み込み中…</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="btn ghost" onClick={onBack}>← 一覧</button>
        <span className="badge">{task.status}</span>
      </div>

      <div className="card">
        <div className="sku">{task.sku}</div>
        <div className="title">{task.title}</div>
        <div className="muted">
          {task.asin && <>ASIN {task.asin}<br /></>}
          仕入 {jpDate(task.purchased_at)} ／ {task.marketplace}
          {task.purchaser_name && <> ／ 仕入担当 {task.purchaser_name}</>}<br />
          販売先 {task.sales_channel ?? '—'} ／ 予定価格 {yen(task.planned_price)}
          {task.tracking_no && <><br />追跡 {task.tracking_no}</>}
        </div>
      </div>

      {/* ── 作業チェック ─────────────────────────── */}
      <div className="card">
        <strong>作業チェック</strong>
        <div className="steps">
          {WORK_STEPS.map((s) => {
            const done = isStepDone(task, s.key);
            return (
              <button
                key={s.key} className="step" data-done={done}
                disabled={pending === s.key} onClick={() => void toggle(s.key)}
              >
                <span className="check">{done ? '✓' : ''}</span>
                <span>
                  <span className="label">{s.label}</span><br />
                  <span className="hint">{s.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 写真 ─────────────────────────────────── */}
      <div className="card">
        <div className="spread">
          <strong>商品写真 {photos.length > 0 && <span className="muted">({photos.length}枚)</span>}</strong>
          <label className="btn" style={{ cursor: 'pointer' }}>
            追加
            <input
              type="file" accept="image/*" multiple capture="environment"
              style={{ display: 'none' }}
              onChange={(e) => void onPhotoPick(e.target.files)}
            />
          </label>
        </div>
        {task.reference_image_url && photos.length === 0 && (
          <p className="muted">参考画像（Amazon）: <img src={task.reference_image_url} alt="" height={48} /></p>
        )}
        <div className="photos">
          {photos.map((url) => <img key={url} src={url} alt="" />)}
        </div>
      </div>

      {/* ── 納品担当者が直してよい項目 ───────────── */}
      <div className="card">
        <strong>検品結果</strong>
        <p className="muted" style={{ marginBottom: 4 }}>コンディション</p>
        <select
          value={task.condition ?? ''}
          onChange={(e) => void saveField({ condition: e.target.value as ItemCondition })}
        >
          <option value="" disabled>選択してください</option>
          {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <p className="muted" style={{ margin: '10px 0 4px' }}>付属品</p>
        <textarea
          defaultValue={task.accessories ?? ''}
          placeholder="・本体 ・電源ケーブル ・リモコン"
          onBlur={(e) => void saveField({ accessories: e.target.value })}
        />

        <p className="muted" style={{ margin: '10px 0 4px' }}>追跡番号</p>
        <input
          type="text" defaultValue={task.tracking_no ?? ''} placeholder="ヤマト1234-5678-9012"
          onBlur={(e) => void saveField({ tracking_no: e.target.value })}
        />
      </div>

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

      {error && <div className="error">{error}</div>}

      {task.description && (
        <div className="card">
          <strong>出品用の説明文</strong>
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{task.description}</p>
        </div>
      )}
    </div>
  );
}
