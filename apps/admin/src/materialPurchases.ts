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
};

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

export function summarizeMaterialPurchases(rows: readonly MaterialPurchase[], month: string, thresholdPercent: number) {
  const { from, until } = materialPurchaseWindow(month);
  const groups = new Map<string, {
    staffId: string | null;
    name: string;
    current: { quantity: number; amount: number } | null;
    history: Map<string, number>;
  }>();
  for (const row of rows) {
    if (row.incurred_on < from || row.incurred_on >= until) continue;
    const key = JSON.stringify([row.staff_id, row.askul_item.normalize('NFKC').replace(/\s+/g, '')]);
    const group = groups.get(key) ?? { staffId: row.staff_id, name: '', current: null, history: new Map<string, number>() };
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
  return [...groups].flatMap(([key, group]) => {
    if (!group.current) return [];
    const history = [...group.history.values()].filter(quantity => quantity > 0);
    const averageQuantity = group.staffId && history.length >= 2
      ? history.reduce((sum, quantity) => sum + quantity, 0) / history.length : null;
    const increased = averageQuantity !== null && group.current.quantity > averageQuantity
      && group.current.quantity >= averageQuantity * thresholdPercent / 100;
    return [{ key, staffId: group.staffId, name: group.name, ...group.current, averageQuantity,
      comparisonMonths: history.length, increased }];
  }).sort((a, b) => Number(b.increased) - Number(a.increased) || b.amount - a.amount || a.name.localeCompare(b.name, 'ja'));
}
