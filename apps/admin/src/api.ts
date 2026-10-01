import { getSupabase } from '@bussan/shared';
import type { SaleRow } from './sales';
import { productCount, readAllRows } from './inventory';
import { validateExpense, type ExpenseInput, type ExpenseDraft } from './expenses';
import type {
  DelivererWorkload, ItemInsert, ItemView, LedgerRow,
  MonthlySummary, Product, SpareAccessory, Staff, StockSummary,
} from '@bussan/shared';

export async function fetchStaff(): Promise<Staff[]> {
  const { data, error } = await getSupabase()
    .from('staff').select('*').eq('is_active', true).order('code');
  if (error) throw error;
  return (data ?? []) as Staff[];
}

export type SpareAccessoryInput = Pick<SpareAccessory,
  'source_sku' | 'owner_staff_id' | 'owner_name' | 'purchased_at' | 'title' | 'cost_amount' |
  'marketplace' | 'marketplace_item_id' | 'tracking_no' | 'usage_note'
>;
export type SpareAccessoryField = keyof Pick<SpareAccessory,
  'source_sku' | 'owner_name' | 'purchased_at' | 'title' | 'cost_amount' |
  'marketplace' | 'marketplace_item_id' | 'tracking_no' | 'usage_note'
>;

export async function createSpareAccessory(input: SpareAccessoryInput): Promise<void> {
  const { error } = await getSupabase().from('spare_accessories').insert(input);
  if (error) throw error;
}

export async function updateSpareAccessory(id: string, field: SpareAccessoryField, value: string | number | null): Promise<void> {
  const { data, error } = await getSupabase().from('spare_accessories').update({ [field]: value }).eq('id', id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('予備付属品が別の画面で変更されたか、更新できません。一覧を読み直してください。');
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

export async function updateExpense(input: ExpenseInput, original: ExpenseInput): Promise<void> {
  validateExpense(input);
  const { id, ...fields } = input;
  let request = getSupabase().from('expenses').update(fields).eq('id', id);
  for (const [key, value] of Object.entries(original)) {
    if (key === 'id') continue;
    request = value === null ? request.is(key, null) : request.eq(key, value);
  }
  const { data, error } = await request.select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('明細が別の画面で変更されたか、更新できません。一覧を読み直してから編集してください。');
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

export async function fetchExpenseDrafts(): Promise<ExpenseDraft[]> {
  return readAllRows<ExpenseDraft>(async (from, to) => {
    const { data, error } = await getSupabase().from('expense_drafts')
      .select('id,target_month,category,name,card_id').order('target_month').order('id').range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as ExpenseDraft[];
  });
}

export type MonthlyDetailItem = Pick<ItemView, 'id' | 'lot_seq' | 'sku' | 'is_accessory' | 'title' | 'marketplace' | 'purchased_at' | 'sold_on' | 'cost_amount' | 'sold_price' | 'payout_amount' | 'refund_amount' | 'profit'> & { shipping_cost: number; other_cost: number };
export async function fetchMonthlyDetail(month: string, kind: 'purchase' | 'sale' | 'expense' | 'profit') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('対象月が不正です。');
  const year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5));
  const from = month + '-01';
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const items = kind === 'expense' ? Promise.resolve([] as MonthlyDetailItem[]) : readAllRows<MonthlyDetailItem>(async (start, end) => {
    const dateColumn = kind === 'purchase' ? 'purchased_at' : 'sold_on';
    const { data, error } = await getSupabase().from('items')
      .select('id,lot_seq,sku,is_accessory,title,marketplace,purchased_at,sold_on,cost_amount,sold_price,payout_amount,refund_amount,profit,shipping_cost,other_cost')
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
  product_id: string | null; product_no: number | null; amazon_image_url: string | null;
  amazon_refund_amount: number; non_amazon_refund_amount: number;
  latest_comment: string | null;
  product_profit: number | null;
  marketplace_item_id: string | null;
};

type PurchaseReference = Pick<ItemView, 'id' | 'sku' | 'marketplace' | 'marketplace_url'> & {
  marketplace_item_id: string | null;
};

async function fetchPurchaseReferences(): Promise<PurchaseReference[]> {
  return readAllRows<PurchaseReference>(async (from, to) => {
    const { data, error } = await getSupabase().from('items')
      .select('id,sku,marketplace,marketplace_url,marketplace_item_id')
      .order('id').range(from, to);
    if (error) throw new Error(error.message);
    return (data ?? []) as PurchaseReference[];
  });
}

/** Read every authorized purchase row so a lot split across pages is still one product. */
export async function fetchSaleRows(): Promise<SaleRow[]> {
  const rows: SaleRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getSupabase().from('items')
      .select('id,lot_seq,sku,is_accessory,cost_amount,sold_on,sold_price,payout_amount')
      .order('id').range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []) as SaleRow[]);
    if ((data?.length ?? 0) < 500) return rows;
  }
}

export async function fetchItems(filter: ItemFilter = {}, signal?: AbortSignal): Promise<{ items: InventoryItem[]; count: number }> {
  const items = await readAllRows<InventoryItem>(async (from, to) => {
    let q = getSupabase().from('v_inventory_display').select('*')
      .order('lot_seq', { ascending: false }).order('sku').order('is_accessory')
      .order('purchased_at', { ascending: false, nullsFirst: false }).order('id')
      .range(from, to);

    if (filter.status) q = q.eq('status', filter.status);
    if (filter.delivererId) q = q.eq('deliverer_id', filter.delivererId);
    if (filter.unsoldOnly) q = q.eq('sale_row_count', 0).neq('status', '返品処理').neq('status', '廃棄');
    if (filter.purchasedFrom) q = q.gte('purchased_at', filter.purchasedFrom);
    if (filter.purchasedTo) q = q.lte('purchased_at', filter.purchasedTo);
    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as InventoryItem[];
  });
  const references = new Map((await fetchPurchaseReferences()).map(row => [row.id, row]));
  const needle = filter.query?.trim().toLocaleLowerCase();
  const filteredItems = needle ? items.filter(item => {
    const reference = references.get(item.id);
    return [item.sku, item.title, item.asin, item.model_no, reference?.marketplace_item_id]
      .some(value => value?.toLocaleLowerCase().includes(needle));
  }) : items;
  return {
    items: filteredItems.map(item => ({
      ...item,
      marketplace_item_id: references.get(item.id)?.marketplace_item_id ?? null,
    })),
    count: productCount(filteredItems),
  };
}

export async function createItem(input: ItemInsert): Promise<{ id: string; sku: string }> {
  if (input.is_accessory) {
    if (!input.lot_seq) throw new Error('付属品には本体と同じ通番号を入力してください。');
    const { data: parent, error: parentError } = await getSupabase()
      .from('items').select('id').eq('lot_seq', input.lot_seq).eq('is_accessory', false).limit(1);
    if (parentError) throw parentError;
    if (!parent?.length) throw new Error('この通番号の本体が見つかりません。本体を先に登録してください。');
  }
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

export type InventoryEdit = Pick<ItemView,
  'title' | 'asin' | 'tracking_no' | 'purchased_at' | 'cost_amount' |
  'planned_price' | 'planned_payout' | 'packed_on' | 'shipped_on' | 'status' |
  'memo' | 'purchaser_id' | 'deliverer_id' | 'marketplace' | 'condition' |
  'sales_channel' | 'sold_on' | 'sold_price' | 'payout_amount' | 'refund_amount'
> & Pick<InventoryItem, 'amazon_refund_amount' | 'non_amazon_refund_amount' | 'marketplace_item_id'>;

export async function updateInventoryItem(item: InventoryItem, fields: InventoryEdit): Promise<void> {
  const title = fields.title.trim();
  if (!title || title.length > 500) throw new Error('商品名を入力してください。');
  if (!Number.isSafeInteger(fields.cost_amount) || fields.cost_amount < 0 ||
      (fields.planned_price !== null && (!Number.isSafeInteger(fields.planned_price) || fields.planned_price < 0)) ||
      (fields.planned_payout !== null && (!Number.isSafeInteger(fields.planned_payout) || fields.planned_payout < 0)) ||
      (fields.sold_price !== null && (!Number.isSafeInteger(fields.sold_price) || fields.sold_price < 0)) ||
      (fields.payout_amount !== null && (!Number.isSafeInteger(fields.payout_amount) || fields.payout_amount < 0)) ||
      !Number.isSafeInteger(fields.refund_amount) || fields.refund_amount < 0 ||
      !Number.isSafeInteger(fields.amazon_refund_amount) || fields.amazon_refund_amount < 0 ||
      !Number.isSafeInteger(fields.non_amazon_refund_amount) || fields.non_amazon_refund_amount < 0) {
    throw new Error('金額は0円以上の整数で入力してください。');
  }
  if (fields.status === '販売済' && (!fields.sold_on || fields.sold_price === null)) throw new Error('販売済にする場合は販売日・価格を入力してください。');
  if (!!fields.sold_on !== (fields.sold_price !== null)) throw new Error('販売日と販売金額は両方入力してください。');
  const { data, error } = await getSupabase().from('items').update({ ...fields, title })
    .eq('id', item.id).eq('updated_at', item.updated_at).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('他の画面で変更されたか、編集権限がありません。在庫一覧を読み直してください。');
}

export type ExpenseField = 'incurred_on' | 'category' | 'name' | 'amount';
export async function updateExpenseField(row: ExpenseInput, field: ExpenseField, value: string): Promise<void> {
  const text = value.trim();
  const next = field === 'amount' ? Number(text) : text;
  if (field === 'amount' && (!text || !Number.isSafeInteger(Number(text)))) throw new Error('金額は整数で入力してください。');
  const revised = { ...row, [field]: next } as ExpenseInput;
  validateExpense(revised);
  const { data, error } = await getSupabase().from('expenses').update({ [field]: next })
    .eq('id', row.id).eq(field, row[field]).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('明細が別の画面で変更されたか、更新できません。一覧を読み直してください。');
}

export async function updateProductNumber(item: InventoryItem, productNo: number | null): Promise<void> {
  if (!item.product_id) throw new Error('商品リストに紐付いていないため、品番を編集できません。');
  if (productNo !== null && (!Number.isSafeInteger(productNo) || productNo <= 0)) throw new Error('品番は1以上の整数にしてください。');
  let query = getSupabase().from('products').update({ product_no: productNo }).eq('id', item.product_id);
  query = item.product_no === null ? query.is('product_no', null) : query.eq('product_no', item.product_no);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('商品リストが変更されたか、編集権限がありません。再読み込みしてください。');
}

export type InventoryField = keyof InventoryEdit | 'product_no' | 'model_no' | 'sku' | 'lot_seq';

/** A cell edit writes only the selected column so another cell cannot be overwritten. */
export async function updateInventoryField(item: InventoryItem, field: InventoryField, value: string): Promise<void> {
  const text = value.trim();
  if (field === 'sku' || field === 'lot_seq') {
    const { error } = await getSupabase().rpc('update_item_identity', {
      p_item_id: item.id,
      p_expected_updated_at: item.updated_at,
      p_field: field,
      p_value: text,
    });
    if (error) throw error;
    return;
  }
  if (field === 'product_no') return updateProductNumber(item, text ? Number(text) : null);
  if (field === 'model_no') {
    if (!item.product_id) throw new Error('商品リストに紐付いていないため型番を編集できません。');
    let query = getSupabase().from('products').update({ model_no: text || null }).eq('id', item.product_id);
    query = item.model_no === null ? query.is('model_no', null) : query.eq('model_no', item.model_no);
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('型番が変更されたか、編集権限がありません。再読み込みしてください。');
    return;
  }
  if (field === 'title' && (!text || text.length > 500)) throw new Error('商品名を入力してください。');
  const numbers = new Set<InventoryField>(['cost_amount', 'planned_price', 'planned_payout', 'sold_price', 'payout_amount', 'refund_amount', 'amazon_refund_amount', 'non_amazon_refund_amount']);
  if (numbers.has(field) && text && (!Number.isSafeInteger(Number(text)) || Number(text) < 0)) throw new Error('金額は0円以上の整数で入力してください。');
  if (field === 'cost_amount' && !text) throw new Error('仕入金額を入力してください。');
  const requiredText = new Set<InventoryField>(['title', 'status', 'marketplace']);
  const next = numbers.has(field) ? (text ? Number(text) : field === 'refund_amount' || field === 'amazon_refund_amount' || field === 'non_amazon_refund_amount' ? 0 : null) : requiredText.has(field) ? text : text || null;
  const { data, error } = await getSupabase().from('items').update({ [field]: next }).eq('id', item.id).eq('updated_at', item.updated_at).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('他の画面で変更されたか、編集権限がありません。在庫一覧を読み直してください。');
}

export type ProductField = 'asin' | 'model_no' | 'product_no' | 'maker' | 'genre' | 'turnover' |
  'list_price' | 'payout_estimate' | 'target_cost' | 'monthly_purchase_cap' | 'has_sold_before';

export async function updateProductField(product: Product, field: ProductField, value: string): Promise<void> {
  const next = field === 'asin' ? value.trim().toUpperCase() : value.trim();
  if (field === 'asin' && !/^[A-Z0-9]{10}$/.test(next)) throw new Error('ASINは英数字10文字で入力してください。');
  if (field === 'turnover' && next && !['高', '中', '低'].includes(next)) throw new Error('回転は高・中・低から選んでください。');
  const numeric = ['product_no', 'list_price', 'payout_estimate', 'target_cost', 'monthly_purchase_cap'].includes(field);
  if (numeric && next && (!Number.isSafeInteger(Number(next)) || Number(next) < (field === 'product_no' ? 1 : 0))) throw new Error('0以上の整数を入力してください（品番は1以上）。');
  const parsed = field === 'has_sold_before' ? next === 'true' : numeric ? next ? Number(next) : null : field === 'asin' ? next : next || null;
  const update = { [field]: parsed };
  let query = getSupabase().from('products').update(update).eq('id', product.id);
  query = product[field] === null ? query.is(field, null) : query.eq(field, product[field]);
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('商品リストが変更されたか、編集権限がありません。再読み込みしてください。');
}

export async function createProduct(input: { asin: string; model_no: string; maker: string; product_no: string }): Promise<void> {
  const asin = input.asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error('ASINは英数字10文字で入力してください。');
  const productNo = input.product_no.trim() ? Number(input.product_no) : null;
  if (productNo !== null && (!Number.isSafeInteger(productNo) || productNo <= 0)) throw new Error('品番は1以上の整数にしてください。');
  const { error } = await getSupabase().from('products').insert({ asin, model_no: input.model_no.trim() || null, maker: input.maker.trim() || null, product_no: productNo });
  if (error) throw error;
}

export async function fetchProducts(query?: string): Promise<Product[]> {
  return readAllRows<Product>(async (from, to) => {
    let q = getSupabase().from('products').select('*').eq('is_active', true).order('product_no').order('id').range(from, to);
    if (query) {
      const term = `%${query.replace(/[(),.%_*"\\]/g, ' ').trim()}%`;
      q = q.or(`asin.ilike.${term},model_no.ilike.${term},maker.ilike.${term}`);
    }
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Product[];
  });
}

export type LedgerDisplayRow = LedgerRow & { 仕入先: string | null; 商品ID: string | null };

export async function fetchLedger(from: string, to: string): Promise<LedgerDisplayRow[]> {
  const { data, error } = await getSupabase()
    .from('v_antique_ledger')
    .select('*')
    .gte('取引年月日', from)
    .lte('取引年月日', to)
    .order('取引年月日');
  if (error) throw error;
  const references = new Map((await fetchPurchaseReferences()).map(row => [row.sku, row]));
  return ((data ?? []) as LedgerRow[]).map(row => {
    const reference = references.get(row.sku);
    return {
      ...row,
      仕入先: row.取引区分 === '買受' ? reference?.marketplace ?? null : null,
      商品ID: row.取引区分 === '買受' ? reference?.marketplace_item_id ?? null : null,
      取引記録リンク: row.取引区分 === '買受' ? reference?.marketplace_url ?? row.取引記録リンク : null,
    };
  });
}

/** 次に使う通番号（画面の初期値用）。同じロットに紐付けたいときは手で上書きする。 */
export async function nextLotSeq(): Promise<number> {
  const { data, error } = await getSupabase()
    .from('items').select('lot_seq').order('lot_seq', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return ((data as { lot_seq: number } | null)?.lot_seq ?? 0) + 1;
}
