// 在庫画面「FBA納品」タブの表示ロジック（画面から切り離してテストできるようにしている）。

export type FbaHistoryShipment = {
  confirmation_id: string | null;
  warehouse: string | null;
  status: string | null;
  tracking: string[];
  boxes: number;
  received: Record<string, number>;
};
export type FbaHistoryItem = {
  item_id: string;
  sku: string;
  title: string;
  serial: number | null;
  status: string | null;
  current_sku: string | null;
  published_at: string | null;
  released_at: string | null;
};
export type FbaHistoryPlan = {
  id: string;
  name: string;
  account: string;
  stage: string;
  staff: { code: string | null; name: string; display_name: string | null } | null;
  created_at: string;
  updated_at: string;
  received_at: string | null;
  has_amazon_plan: boolean;
  waiting_amazon: boolean;
  dispatch_requested_at: string | null;
  ship_date: string | null;
  shipments: FbaHistoryShipment[];
  items: FbaHistoryItem[];
};

export type FbaPlanState = 'draft' | 'working' | 'waiting' | 'transit' | 'receiving' | 'received' | 'cancelled';
export const fbaPlanStateLabels: Record<FbaPlanState, string> = {
  draft: '下書き',
  working: 'Amazonで手続き中',
  waiting: '発送待ち',
  transit: '輸送中',
  receiving: '受領中',
  received: '受領済み',
  cancelled: '取り消し',
};

const receivingStatuses = ['DELIVERED', 'CHECKED_IN', 'RECEIVING'];
const transitStatuses = ['SHIPPED', 'IN_TRANSIT'];

export function fbaPlanState(plan: Pick<FbaHistoryPlan, 'stage' | 'received_at' | 'shipments'>): FbaPlanState {
  if (plan.stage === 'cancelled') return 'cancelled';
  if (plan.stage === 'draft') return 'draft';
  if (plan.stage !== 'ready') return 'working';
  if (plan.received_at) return 'received';
  const statuses = plan.shipments.map(shipment => shipment.status ?? '');
  if (statuses.length && statuses.every(status => status === 'CLOSED')) return 'received';
  if (statuses.some(status => receivingStatuses.includes(status) || status === 'CLOSED')) return 'receiving';
  if (statuses.some(status => transitStatuses.includes(status))) return 'transit';
  return 'waiting';
}

const pad = (value: number) => String(value).padStart(2, '0');

// セラーセントラルの「納品を管理」に出る出荷名。Amazonは発送依頼の時刻（協定世界時）と倉庫コードで名前を付ける。
export function amazonShipmentName(dispatchRequestedAt: string | null, warehouse: string | null): string | null {
  if (!dispatchRequestedAt || !warehouse) return null;
  const at = new Date(dispatchRequestedAt);
  if (Number.isNaN(at.getTime())) return null;
  const stamp = `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  return `FBA STA (${stamp})-${warehouse}`;
}

const tokyo = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const tokyoDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit' });
export const tokyoDateTime = (value: string | null | undefined) => value ? tokyo.format(new Date(value)) : '—';
export const tokyoDayLabel = (value: string | null | undefined) => value ? tokyoDay.format(new Date(value)) : '—';
export const shipDateLabel = (value: string | null | undefined) => {
  const match = value?.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : '—';
};

export function receivedCount(plan: Pick<FbaHistoryPlan, 'shipments' | 'items'>): number {
  const received = new Map<string, number>();
  for (const shipment of plan.shipments) for (const [sku, count] of Object.entries(shipment.received ?? {})) received.set(sku, (received.get(sku) ?? 0) + (Number(count) || 0));
  return plan.items.filter(item => (received.get(item.sku) ?? 0) > 0).length;
}

export type FbaTimelineEvent = { at: string | null; label: string; tone: 'normal' | 'done' | 'muted' };

export function fbaTimeline(plan: FbaHistoryPlan): FbaTimelineEvent[] {
  const events: FbaTimelineEvent[] = [{ at: plan.created_at, label: 'プランを作成', tone: 'normal' }];
  if (plan.stage === 'cancelled') {
    events.push({ at: plan.updated_at, label: 'プランを取り消し', tone: 'muted' });
    return events;
  }
  const warehouses = [...new Set(plan.shipments.map(shipment => shipment.warehouse).filter(Boolean))].join('・');
  if (plan.dispatch_requested_at) events.push({ at: plan.dispatch_requested_at, label: `Amazonで出荷を確定${warehouses ? `（${warehouses}）` : ''}`, tone: 'normal' });
  else if (plan.stage === 'ready' && plan.shipments.length) events.push({ at: null, label: `Amazonで出荷を確定${warehouses ? `（${warehouses}）` : ''}`, tone: 'normal' });
  if (plan.ship_date) events.push({ at: null, label: `発送日 ${shipDateLabel(plan.ship_date)}`, tone: 'normal' });
  const tracking = plan.shipments.flatMap(shipment => shipment.tracking);
  if (tracking.length) events.push({ at: null, label: `追跡番号を登録（${tracking.join('、')}）`, tone: 'normal' });
  const state = fbaPlanState(plan);
  const received = receivedCount(plan);
  if (state === 'receiving' && received > 0) events.push({ at: null, label: `Amazonが受領中（${received}/${plan.items.length}点）`, tone: 'normal' });
  if (plan.received_at) events.push({ at: plan.received_at, label: `Amazonが受領（${received || plan.items.length}/${plan.items.length}点）`, tone: 'done' });
  const published = plan.items.map(item => item.published_at).filter((value): value is string => !!value).sort();
  if (published.length) events.push({ at: published[published.length - 1] ?? null, label: published.length === plan.items.length ? '全点が出品中に反映' : `${published.length}/${plan.items.length}点が出品中に反映`, tone: 'done' });
  return events;
}

export type FbaHistoryFilters = { account: string; state: FbaPlanState | ''; query: string; showCancelled: boolean };

export function filterFbaPlans(plans: FbaHistoryPlan[], filters: FbaHistoryFilters): FbaHistoryPlan[] {
  const query = filters.query.normalize('NFKC').trim().toLowerCase();
  return plans.filter(plan => {
    const state = fbaPlanState(plan);
    if (!filters.showCancelled && state === 'cancelled' && filters.state !== 'cancelled') return false;
    if (filters.account && plan.account !== filters.account) return false;
    if (filters.state && state !== filters.state) return false;
    if (!query) return true;
    const names = plan.shipments.map(shipment => [shipment.confirmation_id, shipment.warehouse, amazonShipmentName(plan.dispatch_requested_at, shipment.warehouse), ...shipment.tracking]);
    const text = [plan.name, ...names.flat(), ...plan.items.flatMap(item => [item.sku, item.current_sku, item.title, item.serial == null ? '' : String(item.serial)])]
      .filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
    return text.includes(query);
  });
}

export function fbaSummary(plans: FbaHistoryPlan[], now = new Date()) {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(now);
  const inMonth = (value: string | null) => !!value && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date(value)) === month;
  let draft = 0, open = 0, receivedThisMonth = 0, itemsThisMonth = 0;
  for (const plan of plans) {
    const state = fbaPlanState(plan);
    if (state === 'draft') draft++;
    if (['working', 'waiting', 'transit', 'receiving'].includes(state)) open++;
    if (state === 'received' && inMonth(plan.received_at)) receivedThisMonth++;
    if (state !== 'cancelled' && state !== 'draft' && inMonth(plan.dispatch_requested_at ?? plan.created_at)) itemsThisMonth += plan.items.length;
  }
  return { draft, open, receivedThisMonth, itemsThisMonth };
}
