import { getSupabase } from '@bussan/shared';
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

export async function fetchMonthly(limit = 12): Promise<MonthlySummary[]> {
  const { data, error } = await getSupabase()
    .from('v_monthly_summary').select('*').limit(limit);
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
}

export async function fetchItems(filter: ItemFilter = {}, limit = 500): Promise<ItemView[]> {
  let q = getSupabase().from('v_items').select('*').order('purchased_at', { ascending: false }).limit(limit);

  if (filter.status) q = q.eq('status', filter.status);
  if (filter.delivererId) q = q.eq('deliverer_id', filter.delivererId);
  if (filter.unsoldOnly) q = q.is('sold_on', null);
  if (filter.query) {
    const term = `%${filter.query}%`;
    q = q.or(`sku.ilike.${term},title.ilike.${term},asin.ilike.${term},model_no.ilike.${term}`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ItemView[];
}

export async function createItem(input: ItemInsert): Promise<{ id: string; sku: string }> {
  const { data, error } = await getSupabase()
    .from('items').insert(input).select('id, sku').single();
  if (error) throw error;
  return data as { id: string; sku: string };
}

export async function recordSale(itemId: string, sale: {
  sold_on: string; sold_price: number; payout_amount: number; shipping_cost?: number;
}) {
  const { error } = await getSupabase().from('items').update(sale).eq('id', itemId);
  if (error) throw error;
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
