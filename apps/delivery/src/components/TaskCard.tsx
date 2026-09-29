import { jpDate } from '@bussan/shared';
import type { DeliveryTask, Staff } from '@bussan/shared';
import TaskDetail from '../pages/TaskDetail';

const STEP_FLAGS = (t: DeliveryTask) => [
  t.inspected && t.cleaned,
  t.product_registered && t.photo_uploaded,
  t.packed_on !== null,
  t.shipped_on !== null,
];

export default function TaskCard({ task, thumbnailUrl, members, staff, expandedId, onOpenMember, onOpen, onClose, onTaskChange, selected, onSelect, disabled }: { task: DeliveryTask; thumbnailUrl: string | null; members: DeliveryTask[]; staff: Staff; expandedId: string | null; onOpenMember: (id: string) => void; onOpen: () => void; onClose: () => void; onTaskChange: (task: DeliveryTask) => void; selected: boolean; onSelect: () => void; disabled: boolean }) {
  const flags = STEP_FLAGS(task);
  const done = flags.filter(Boolean).length;

  return (
    <div className="card task-card" data-expanded={!!expandedId}>
      <input type="checkbox" aria-label={`${task.sku}を出力対象に選択`} checked={selected} disabled={disabled} onChange={onSelect} />
      <div className="task-content">
      <button className="task-open" aria-expanded={!!expandedId} onClick={onOpen}>
      <div className="task-card-overview">
        <div className="task-card-info">
          <span className="muted">購入日 {jpDate(task.purchased_at)}</span>
          <span className="muted">販売先 {task.sales_channel || '—'}</span>
          <span className="sku">SKU {task.sku}</span>
          <span className="title">{task.is_accessory && <span className="badge" style={{ marginRight: 6 }}>付属品</span>}型番 {task.title}</span>
          <span className="muted product-asin">ASIN {task.asin || '—'}</span>
          <span className="muted">追跡番号 {task.tracking_no || '—'}</span>
        </div>
        {thumbnailUrl ? <img className="task-card-photo" src={thumbnailUrl} alt={`${task.title}の写真`} loading="lazy" /> : <div className="task-card-photo task-card-no-photo" aria-label="写真未登録">写真なし</div>}
      </div>
      <div className="progress" aria-label={`作業 ${done}/${flags.length}`}>
        {flags.map((f, i) => <span key={i} data-done={f} />)}
      </div>
      </button>
      {members.length > 1 && <div className="task-members">
        {members.filter(member => member.id !== task.id).map(member => <button key={member.id} className="btn" aria-expanded={expandedId === member.id} onClick={() => onOpenMember(member.id)}>
          {member.is_accessory ? '付属品' : '同じ商品'}：{member.title}
          <span className="muted">{jpDate(member.purchased_at)} ／ 追跡番号 {member.tracking_no || '—'}</span>
        </button>)}
      </div>}
      </div>
      {expandedId && <TaskDetail key={expandedId} itemId={expandedId} staff={staff} onClose={onClose} onChanged={onTaskChange} />}
    </div>
  );
}
