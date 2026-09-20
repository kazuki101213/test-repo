import { jpDate } from '@bussan/shared';
import type { DeliveryTask } from '@bussan/shared';

const STEP_FLAGS = (t: DeliveryTask) => [
  t.arrived_on !== null,
  t.product_registered,
  t.inspected,
  t.photo_uploaded,
  t.packed_on !== null,
  t.shipped_on !== null,
];

export default function TaskCard({ task, onOpen }: { task: DeliveryTask; onOpen: () => void }) {
  const flags = STEP_FLAGS(task);
  const done = flags.filter(Boolean).length;

  return (
    <button className="card" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={onOpen}>
      <div className="spread">
        <span className="sku">{task.sku}</span>
        <span className={`badge ${done === flags.length ? 'done' : 'todo'}`}>
          {done}/{flags.length}
        </span>
      </div>
      <div className="title">
        {task.is_accessory && <span className="badge" style={{ marginRight: 6 }}>付属品</span>}
        {task.title}
      </div>
      <div className="muted">
        {task.work_stream ? `${task.work_stream}・` : ''}
        購入 {jpDate(task.purchased_at)}
        {task.tracking_no ? ` ・ ${task.tracking_no}` : ''}
      </div>
      <div className="progress">
        {flags.map((f, i) => <span key={i} data-done={f} />)}
      </div>
    </button>
  );
}
