import { getSupabase } from '@bussan/shared';
import type { SaleRow } from './sales';
import { productCount, readAllRows } from './inventory';
import { validateExpense, type ExpenseInput } from './expenses';
import type {
  DelivererWorkload, ItemInsert, ItemView, LedgerRow,
  MonthlySummary, Product, Staff, StockSummary,
} from '@bussan/shared';

export async function fetchStaff(): Promise<Staff[]> {
  const { data, error } = await getSupabase()
    .from('staff').select('*').eq('is_active', true).order('code');
  if (error) throw error;
  return (data ?? []) as Staff[];
}

export async function fetchCards(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabase()
    .from('payment_cards').select('id, name').eq('is_active', true).order('name');
  if (error) throw error;
  const paymentOrder = ['PayPayカード', 'セゾンカード', 'アメックスカード', 'メルカリ残高', '楽天カード', '振込', '現金'];
  return ((data ?? []) as { id: string; name: string }[]).sort((a, b) => {
    const rank = (name: string) => { const index = paymentOrder.indexOf(name); return index < 0 ? paymentOrder.length : index; };
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ja');
  });
}

export async function fetchStockSummary(): Promise<StockSummary | null> {
  const { data, error } = await getSupabase().from('v_stock_summary').select('*').maybeSingle();
  if (error) throw error;
  return (data as StockSummary) ?? null;
}

export async function fetchMonthly(): Promise<MonthlySummary[]> {
  const { data, error } = await getSupabase()
    .from('v_monthly_summary').select('*').not('month', 'is', null).order('month', { ascending: false });
  if (error) throw error;
  return (data ?? []) as MonthlySummary[];
}

export async function fetchWorkload(): Promise<DelivererWorkload[]> {
  const { data, error } = await getSupabase().from('v_deliverer_workload').select('*');
  if (error) throw error;
  return (data ?? []) as DelivererWorkload[];
}

export interface ItemFilter {
  status?: string;
  delivererId?: string;
  query?: string;
  unsoldOnly?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
}

export type WorkloadMetric = '未完了' | '今月出荷' | '平均作業日数';
export type WorkloadItem = Pick<ItemView, 'id' | 'lot_seq' | 'sku' | 'title' | 'status' | 'marketplace' | 'purchased_at' | 'arrived_on' | 'shipped_on'>;

export async function fetchWorkloadDetail(delivererId: string, metric: WorkloadMetric): Promise<WorkloadItem[]> {
  // Match v_deliverer_workload: row counts and the database's UTC calendar month.
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  return readAllRows<WorkloadItem>(async (from, to) => {
    let query = getSupabase().from('items')
      .select('id,lot_seq,sku,title,status,marketplace,purchased_at,arrived_on,shipped_on')
      .eq('deliverer_id', delivererId);
    if (metric === '未完了') query = query.in('status', ['仕入済', '入荷済', '作業中', 'Amazon返品']);
    else if (metric === '今月出荷') query = query.gte('shipped_on', monthStart);
    else query = query.not('shipped_on', 'is', null).not('arrived_on', 'is', null);
    const { data, error } = await query.order('lot_seq', { ascending: false }).order('id').range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as WorkloadItem[];
  });
}

export async function saveExpense(input: ExpenseInput): Promise<void> {
  return saveExpenses([input]);
}

export async function saveExpenses(inputs: ExpenseInput[]): Promise<void> {
  if (inputs.length === 0 || inputs.length > 120) throw new Error('登録する経費は1〜120件で指定してください。');
  inputs.forEach(validateExpense);
  const { error } = await getSupabase().from('expenses').insert(inputs);
  if (!error) return;
  // Reuse the form's UUID after an uncertain network result, without duplicating an expense.
  if (error.code === '23505') {
    const { data, error: readError } = await getSupabase().from('expenses').select('*').in('id', inputs.map(input => input.id));
    if (!readError && data?.length === inputs.length && inputs.every(input => {
      const saved = data.find(row => row.id === input.id);
      return saved && Object.entries(input).every(([key, value]) => saved[key] === value);
    })) return;
    throw new Error('前回の保存内容と異なります。保存済みの可能性があるため、再登録を中止しました。');
  }
  throw new Error(error.message);
}

export async function fetchExpenses(): Promise<ExpenseInput[]> {
  return readAllRows<ExpenseInput>(async (from, to) => {
    const { data, error } = await getSupabase().from('expenses')
      .select('id,incurred_on,category,name,amount,card_id,staff_id,memo')
      .order('incurred_on', { ascending: false }).order('id').range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExpenseInput[];
  });
}

export type MonthlyDetailItem = Pick<ItemView, 'id' | 'lot_seq' | 'is_accessory' | 'title' | 'marketplace' | 'purchased_at' | 'sold_on' | 'cost_amount' | 'sold_price' | 'payout_amount' | 'refund_amount' | 'profit'> & { shipping_cost: number; other_cost: number };
export async function fetchMonthlyDetail(month: string, kind: 'purchase' | 'sale' | 'expense' | 'profit') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月が不正です。');
  const year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5));
  const from = month + '-01';
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const items = kind === 'expense' ? Promise.resolve([] as MonthlyDetailItem[]) : readAllRows<MonthlyDetailItem>(async (start, end) => {
    const dateColumn = kind === 'purchase' ? 'purchased_at' : 'sold_on';
    const { data, error } = await getSupabase().from('items')
      .select('id,lot_seq,is_accessory,title,marketplace,purchased_at,sold_on,cost_amount,sold_price,payout_amount,refund_amount,profit,shipping_cost,other_cost')
      .gte(dateColumn, from).lte(dateColumn, to).order('lot_seq', { ascending: false }).order('id').range(start, end);
    if (error) throw new Error(error.message);
    return (data ?? []) as MonthlyDetailItem[];
  });
  const expenses = kind !== 'expense' && kind !== 'profit' ? Promise.resolve([] as ExpenseInput[]) : readAllRows<ExpenseInput>(async (start, end) => {
    const { data, error } = await getSupabase().from('expenses')
      .select('id,incurred_on,category,name,amount,card_id,staff_id,memo')
      .gte('incurred_on', from).lte('incurred_on', to).order('incurred_on').order('id').range(start, end);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExpenseInput[];
  });
  const [itemRows, expenseRows] = await Promise.all([items, expenses]);
  return { items: itemRows, expenses: expenseRows };
}

export type InventoryItem = ItemView & {
  product_row_count: number; product_cost: number; sale_row_count: number;
  product_sale_conflict: boolean; product_sold_on: string | null;
  product_sold_price: number | null; product_payout_amount: number | null;
};

/** Read every authorized purchase row so a lot split across pages is still one product. */
export async function fetchSaleRows(): Promise<SaleRow[]> {
  const rows: SaleRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getSupabase().from('items')
      .select('id,lot_seq,is_accessory,cost_amount,sold_on,sold_price,payout_amount')
      .order('id').range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []) as SaleRow[]);
    if ((data?.length ?? 0) < 500) return rows;
  }
}

export async function fetchItems(filter: ItemFilter = {}, signal?: AbortSignal): Promise<{ items: InventoryItem[]; count: number }> {
  const items = await readAllRows<InventoryItem>(async (from, to) => {
    let q = getSupabase().from('v_inventory_items').select('*')
      .order('lot_seq', { ascending: false }).order('is_accessory')
      .order('purchased_at', { ascending: false, nullsFirst: false }).order('id')
      .range(from, to);

    if (filter.status) q = q.eq('status', filter.status);
    if (filter.delivererId) q = q.eq('deliverer_id', filter.delivererId);
    if (filter.unsoldOnly) q = q.eq('sale_row_count', 0);
    if (filter.purchasedFrom) q = q.gte('purchased_at', filter.purchasedFrom);
    if (filter.purchasedTo) q = q.lte('purchased_at', filter.purchasedTo);
    if (filter.query) {
      const term = `%${filter.query.replace(/[(),.%_*"\\]/g, ' ')}%`;
      q = q.or(`sku.ilike.${term},title.ilike.${term},asin.ilike.${term},model_no.ilike.${term}`);
    }

    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as InventoryItem[];
  });
  return { items, count: productCount(items) };
}

export async function createItem(input: ItemInsert): Promise<{ id: string; sku: string }> {
  const { data, error } = await getSupabase()
    .from('items').insert(input).select('id, sku').single();
  if (error) throw error;
  return data as { id: string; sku: string };
}

export async function recordSale(itemId: string, sale: {
  sold_on: string; sold_price: number; payout_amount: number;
}) {
  const { data, error } = await getSupabase().from('items').update(sale).eq('id', itemId).is('sold_on', null).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('販売済み、または編集権限がありません。一覧を再読み込みしてください。');
}

export async function fetchProducts(query?: string): Promise<Product[]> {
  let q = getSupabase().from('products').select('*').order('product_no').limit(1000);
  if (query) {
    const term = `%${query}%`;
    q = q.or(`asin.ilike.${term},model_no.ilike.${term},maker.ilike.${term}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Product[];
}

export async function fetchLedger(from: string, to: string): Promise<LedgerRow[]> {
  const { data, error } = await getSupabase()
    .from('v_antique_ledger')
    .select('*')
    .gte('取引年月日', from)
    .lte('取引年月日', to)
    .order('取引年月日');
  if (error) throw error;
  return (data ?? []) as LedgerRow[];
}

/** 次に使う通番号（画面の初期値用）。同じロットに紐付けたいときは手で上書きする。 */
export async function nextLotSeq(): Promise<number> {
  const { data, error } = await getSupabase()
    .from('items').select('lot_seq').order('lot_seq', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return ((data as { lot_seq: number } | null)?.lot_seq ?? 0) + 1;
}
