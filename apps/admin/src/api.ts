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
  return (data ?? []) as { id: string; name: string }[];
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

export async function saveExpense(input: ExpenseInput): Promise<void> {
  validateExpense(input);
  const { error } = await getSupabase().from('expenses').insert(input);
  if (!error) return;
  // Reuse the form's UUID after an uncertain network result, without duplicating an expense.
  if (error.code === '23505') {
    const { data, error: readError } = await getSupabase().from('expenses').select('*').eq('id', input.id).single();
    if (!readError && data && Object.entries(input).every(([key, value]) => data[key] === value)) return;
    throw new Error('前回の保存内容と異なるため再登録していません。入力画面を閉じて、経費一覧を確認してください。');
  }
  throw new Error(error.message);
}

export async function fetchRecentExpenses(): Promise<ExpenseInput[]> {
  const { data, error } = await getSupabase().from('expenses').select('id,incurred_on,category,name,amount,card_id,staff_id,memo')
    .order('incurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as ExpenseInput[];
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

export async function fetchAmazonFeed(): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase().from('v_amazon_listing_feed').select('*');
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

/** 次に使う通番号（画面の初期値用）。同じロットに紐付けたいときは手で上書きする。 */
export async function nextLotSeq(): Promise<number> {
  const { data, error } = await getSupabase()
    .from('items').select('lot_seq').order('lot_seq', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return ((data as { lot_seq: number } | null)?.lot_seq ?? 0) + 1;
}
