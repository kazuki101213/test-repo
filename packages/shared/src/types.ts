/** DB の enum と 1:1 で対応する型。migration を変えたらここも直す。 */

export type StaffRole = 'admin' | 'purchaser' | 'deliverer';

export type Marketplace =
  | 'メルカリ' | 'ヤフオク' | 'ヤフフリ' | 'PayPayフリマ'
  | 'ラクマ' | 'オフモール' | '店舗' | 'その他';

export type SalesChannel = 'FBA' | '自己発送' | 'メルカリ' | 'ヤフオク' | 'ヤフフリ' | 'その他';

export type ItemCondition =
  | '新品' | '再生品' | 'ほぼ新品' | '非常に良い' | '良い' | '可' | 'ジャンク';

export type ItemStatus =
  | '仕入済' | '入荷済' | '作業中' | '出荷済' | '出品中'
  | '販売済' | '返品' | '保留' | '廃棄';

export type WorkStream = 'テレビ' | 'ブルーレイ' | '付属品' | 'その他';

export type TurnoverClass = '高' | '中' | '低';

export type ExpenseCategory = '固定費' | '変動費' | '給与' | '外注費' | '諸経費';

export type WorkStep = 'arrived' | 'registered' | 'inspected' | 'photo' | 'packed' | 'shipped';

export interface Staff {
  id: string;
  code: string;
  name: string;
  display_name: string | null;
  role: StaffRole;
  is_company: boolean;
  email: string | null;
  is_active: boolean;
}

export interface Product {
  id: string;
  product_no: number | null;
  asin: string;
  model_no: string | null;
  maker: string | null;
  genre: string | null;
  list_price: number | null;
  payout_estimate: number | null;
  target_cost: number | null;
  turnover: TurnoverClass | null;
  has_sold_before: boolean;
  monthly_purchase_cap: number | null;
  expected_sales_qty: number | null;
  image_url: string | null;
  keepa_url: string | null;
  amazon_url: string;
  memo: string | null;
  is_active: boolean;
}

/** app.items の書き込み用（SKU は DB 側で採番されるので任意） */
export interface ItemInsert {
  sku?: string;
  lot_seq?: number;
  is_accessory?: boolean;
  purchaser_id: string;
  deliverer_id?: string | null;
  work_stream?: WorkStream | null;
  purchased_at: string;
  title: string;
  cost_amount: number;
  marketplace: Marketplace;
  marketplace_item_id?: string | null;
  marketplace_url?: string | null;
  card_id?: string | null;
  tracking_no?: string | null;
  product_id?: string | null;
  asin?: string | null;
  condition?: ItemCondition | null;
  accessories?: string | null;
  description?: string | null;
  planned_price?: number | null;
  planned_payout?: number | null;
  sales_channel?: SalesChannel | null;
  seller_name?: string | null;
  seller_address?: string | null;
  seller_occupation?: string | null;
  seller_age?: number | null;
  memo?: string | null;
}

/** app.v_items の 1 行 */
export interface ItemView {
  id: string;
  sku: string;
  lot_seq: number;
  is_accessory: boolean;
  status: ItemStatus;
  condition: ItemCondition | null;
  title: string;
  asin: string | null;
  model_no: string | null;
  maker: string | null;
  genre: string | null;
  turnover: TurnoverClass | null;
  purchased_at: string;
  cost_amount: number;
  marketplace: Marketplace;
  marketplace_url: string | null;
  card_name: string | null;
  purchaser_name: string | null;
  deliverer_name: string | null;
  work_stream: WorkStream | null;
  deliverer_id: string | null;
  purchaser_id: string;
  tracking_no: string | null;
  planned_price: number | null;
  planned_payout: number | null;
  sales_channel: SalesChannel | null;
  arrived_on: string | null;
  product_registered: boolean;
  inspected: boolean;
  photo_uploaded: boolean;
  packed_on: string | null;
  shipped_on: string | null;
  listed_on: string | null;
  sold_on: string | null;
  sold_price: number | null;
  payout_amount: number | null;
  profit: number;
  days_to_sell: number | null;
  days_in_stock: number | null;
  expected_profit: number | null;
  accessories: string | null;
  memo: string | null;
  updated_at: string;
}

/** app.v_delivery_tasks の 1 行 */
export interface DeliveryTask {
  id: string;
  sku: string;
  lot_seq: number;
  is_accessory: boolean;
  status: ItemStatus;
  work_stream: WorkStream | null;
  title: string;
  asin: string | null;
  condition: ItemCondition | null;
  purchased_at: string;
  marketplace: Marketplace;
  tracking_no: string | null;
  accessories: string | null;
  description: string | null;
  sales_channel: SalesChannel | null;
  planned_price: number | null;
  deliverer_id: string | null;
  purchaser_name: string | null;
  arrived_on: string | null;
  product_registered: boolean;
  inspected: boolean;
  photo_uploaded: boolean;
  packed_on: string | null;
  shipped_on: string | null;
  reference_image_url: string | null;
  photo_count: number;
  last_comment_at: string | null;
}

export interface ItemComment {
  id: string;
  item_id: string;
  author_id: string;
  body: string;
  created_at: string;
}

export interface MonthlySummary {
  month: string;
  仕入数: number;
  仕入金額: number;
  平均仕入額: number;
  販売数: number;
  売上: number;
  振込金額: number;
  粗利益: number;
  平均販売額: number;
  平均回転日数: number | null;
  経費: number;
  純利益: number;
}

export interface StockSummary {
  現在庫数: number;
  仕入金額合計: number;
  売上見込み合計: number;
  見込み利益合計: number;
  高回転: number;
  中回転: number;
  低回転: number;
  作業中: number;
  入荷待ち: number;
}

export interface DelivererWorkload {
  deliverer_id: string;
  deliverer_name: string;
  未完了: number;
  作業中: number;
  今月出荷: number;
  手元在庫: number;
  平均作業日数: number | null;
}

export interface LedgerRow {
  sku: string;
  取引区分: '買受' | '売却';
  取引年月日: string;
  品目: string;
  特徴: string;
  数量: number;
  代価: number;
  相手方: string;
  相手方住所: string | null;
  相手方職業: string | null;
  相手方年齢: number | null;
  確認方法: string | null;
  取引記録URL: string | null;
}
