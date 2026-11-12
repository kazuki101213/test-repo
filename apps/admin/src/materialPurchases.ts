export type MaterialPurchase = {
  incurred_on: string;
  name: string;
  staff_id: string | null;
  amount: number;
  askul_item: string;
  askul_quantity: number;
};

export type MaterialAnalysisInput = {
  row: number;
  quantity: number;
  amount: number;
  averageQuantity: number | null;
  comparisonMonths: number;
  increased: boolean;
  completedItems: number;
  quantityPerItem: number | null;
  peerQuantityPerItem: number | null;
  peerCount: number;
  abovePeers: boolean;
};

export type MaterialWorkload = { completedItems: number; recorderItems: number };
export type BubbleWrapEstimate = {
  recorderItems: number;
  estimatedMetres: number;
  purchasedMetres: number | null;
};

export const bubbleWrapMetresPerRecorder = 4;

export type MaterialAnalysis = {
  summary: string;
  notes: { row: number; reason: string }[];
};

export function materialPurchaseWindow(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('集計する月を選択してください。');
  const [year, calendarMonth] = month.split('-').map(Number);
  const date = new Date(`${month}-01T00:00:00Z`);
  const offset = (months: number) => {
    const shifted = new Date(date);
    shifted.setUTCMonth((calendarMonth ?? 1) - 1 + months);
    return shifted.toISOString().slice(0, 10);
  };
  if (!year || year < 2000) throw new Error('集計する月を選択してください。');
  return { from: offset(-3), until: offset(1) };
}

export function summarizeMaterialPurchases(
  rows: readonly MaterialPurchase[], month: string, thresholdPercent: number,
  workload: ReadonlyMap<string, MaterialWorkload> = new Map(),
) {
  const { from, until } = materialPurchaseWindow(month);
  const groups = new Map<string, {
    staffId: string | null;
    item: string;
    name: string;
    current: { quantity: number; amount: number } | null;
    history: Map<string, number>;
  }>();
  for (const row of rows) {
    if (row.incurred_on < from || row.incurred_on >= until) continue;
    const item = row.askul_item.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const key = JSON.stringify([row.staff_id, item]);
    const group = groups.get(key) ?? { staffId: row.staff_id, item, name: '', current: null, history: new Map<string, number>() };
    const rowMonth = row.incurred_on.slice(0, 7);
    if (rowMonth === month) {
      const current = group.current ?? { quantity: 0, amount: 0 };
      current.quantity += row.askul_quantity;
      current.amount += row.amount;
      group.current = current;
      if (!group.name || row.name.length < group.name.length) group.name = row.name;
    } else {
      group.history.set(rowMonth, (group.history.get(rowMonth) ?? 0) + row.askul_quantity);
    }
    groups.set(key, group);
  }
  const cohorts = new Map<string, { staff: number; quantity: number; completed: number }>();
  for (const group of groups.values()) {
    const completed = group.staffId ? workload.get(group.staffId)?.completedItems ?? 0 : 0;
    if (!group.current || group.current.quantity <= 0 || completed <= 0) continue;
    const cohort = cohorts.get(group.item) ?? { staff: 0, quantity: 0, completed: 0 };
    cohort.staff++;
    cohort.quantity += group.current.quantity;
    cohort.completed += completed;
    cohorts.set(group.item, cohort);
  }
  return [...groups].flatMap(([key, group]) => {
    if (!group.current) return [];
    const history = [...group.history.values()].filter(quantity => quantity > 0);
    const averageQuantity = group.staffId && history.length >= 2
      ? history.reduce((sum, quantity) => sum + quantity, 0) / history.length : null;
    const increased = averageQuantity !== null && group.current.quantity > averageQuantity
      && group.current.quantity >= averageQuantity * thresholdPercent / 100;
    const completedItems = group.staffId ? workload.get(group.staffId)?.completedItems ?? 0 : 0;
    const quantityPerItem = completedItems > 0 && group.current.quantity > 0 ? group.current.quantity / completedItems : null;
    const cohort = cohorts.get(group.item);
    const peerCount = cohort && quantityPerItem !== null ? cohort.staff - 1 : 0;
    const peerQuantityPerItem = cohort && peerCount > 0
      ? (cohort.quantity - group.current.quantity) / (cohort.completed - completedItems) : null;
    const abovePeers = quantityPerItem !== null && peerQuantityPerItem !== null && quantityPerItem > peerQuantityPerItem
      && quantityPerItem >= peerQuantityPerItem * thresholdPercent / 100;
    return [{ key, staffId: group.staffId, name: group.name, ...group.current, averageQuantity,
      comparisonMonths: history.length, increased, completedItems, quantityPerItem, peerQuantityPerItem, peerCount, abovePeers }];
  }).sort((a, b) => Number(b.abovePeers) - Number(a.abovePeers) || Number(b.increased) - Number(a.increased)
    || b.amount - a.amount || a.name.localeCompare(b.name, 'ja'));
}

export function summarizeBubbleWrap(
  rows: readonly MaterialPurchase[], month: string, workload: ReadonlyMap<string, MaterialWorkload>,
) {
  const purchases = new Map<string, { metres: number; unknown: boolean }>();
  for (const row of rows) {
    if (!row.staff_id || !row.incurred_on.startsWith(month + '-') || !row.askul_quantity) continue;
    const item = row.askul_item.normalize('NFKC').toLowerCase();
    if (!/プチプチ|気泡緩衝材|エアキャップ/.test(item)) continue;
    const total = purchases.get(row.staff_id) ?? { metres: 0, unknown: false };
    const lengths = [...item.matchAll(/(\d+(?:\.\d+)?)\s*m(?![a-z0-9])/g)];
    const rolls = [...item.matchAll(/(\d+)\s*巻/g)];
    const metresPerRoll = Number(lengths[0]?.[1] ?? 0);
    const rollsPerUnit = Number(rolls[0]?.[1] ?? 1);
    if (lengths.length !== 1 || rolls.length > 1 || (!rolls.length && !/m\s*巻/.test(item))
        || metresPerRoll <= 0 || rollsPerUnit <= 0) {
      total.unknown = true;
    } else {
      total.metres += row.askul_quantity * metresPerRoll * rollsPerUnit;
    }
    purchases.set(row.staff_id, total);
  }
  return [...new Set([...workload.keys(), ...purchases.keys()])].flatMap(staffId => {
    const recorderItems = workload.get(staffId)?.recorderItems ?? 0;
    const purchase = purchases.get(staffId);
    if (!recorderItems && !purchase) return [];
    return [{ staffId, recorderItems, estimatedMetres: recorderItems * bubbleWrapMetresPerRecorder,
      purchasedMetres: purchase && !purchase.unknown ? purchase.metres : null,
      hasPurchase: !!purchase }];
  }).sort((a, b) => b.recorderItems - a.recorderItems || a.staffId.localeCompare(b.staffId));
}
