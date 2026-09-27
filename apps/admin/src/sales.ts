export type SaleRow = {
  id: string; lot_seq: number; is_accessory: boolean; cost_amount: number;
  sold_on: string | null; sold_price: number | null; payout_amount: number | null;
};
export type ProductGroup = {
  lot: number; ids: string[]; cost: number; sale: SaleRow | null;
  conflict: boolean; saleDates: string[];
};

// Purchase rows remain separate. A physical product is identified by its lot number.
export function groupProducts(rows: SaleRow[]): Map<number, ProductGroup> {
  const members = new Map<number, SaleRow[]>();
  for (const row of rows) {
    const group = members.get(row.lot_seq) ?? [];
    group.push(row); members.set(row.lot_seq, group);
  }
  const groups = new Map<number, ProductGroup>();
  for (const [lot, group] of members) {
    // Zero-value accessory rows record cost, not a second sale.
    const sales = group.filter(r => r.sold_on && !(r.is_accessory && (r.sold_price ?? 0) === 0 && (r.payout_amount ?? 0) === 0));
    const signatures = new Set(sales.map(r => `${r.sold_on}|${r.sold_price}|${r.payout_amount}`));
    const conflict = signatures.size > 1 || sales.some(r => r.sold_price === null);
    const sale = conflict ? null : [...sales].sort((a, b) => Number(a.is_accessory) - Number(b.is_accessory) || a.id.localeCompare(b.id))[0] ?? null;
    groups.set(lot, { lot, ids: group.map(r => r.id), cost: group.reduce((sum, r) => sum + r.cost_amount, 0), sale, conflict,
      saleDates: [...new Set(sales.map(r => r.sold_on!))] });
  }
  return groups;
}

export function dailySales(groups: Iterable<ProductGroup>, month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('表示する月を選択してください。');
  const year = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const days = Array.from({ length: new Date(Date.UTC(year, m, 0)).getUTCDate() }, (_, i) => ({
    date: `${month}-${String(i + 1).padStart(2, '0')}`, amount: 0, count: 0,
  }));
  const conflicts: number[] = [];
  for (const group of groups) {
    if (group.conflict && group.saleDates.some(date => date.startsWith(month + '-'))) { conflicts.push(group.lot); continue; }
    if (!group.sale?.sold_on?.startsWith(month + '-')) continue;
    const day = days[Number(group.sale.sold_on.slice(8, 10)) - 1];
    if (day) { day.amount += group.sale.sold_price ?? 0; day.count++; }
  }
  return { days, conflicts };
}

export const japanMonth = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
