/** DB の enum と 1:1 で対応する型。migration を変えたらここも直す。 */

export type StaffRole = 'admin' | 'purchaser' | 'deliverer';

export type Marketplace =
  | 'メルカリ' | 'ヤフオク' | 'ヤフフリ' | 'PayPayフリマ' | 'ラクマ' | 'ジモティー'
  | 'オフモール' | '2ndストリート' | 'トレジャーファクトリー' | '楽天' | '店舗'
  | 'Amazon返品' | '動作品Amazon返品' | 'Amazon' | 'Yahoo！ショッピング' | 'その他';

export type SalesChannel = 'FBA' | '自己発送' | 'メルカリ' | 'ヤフオク' | 'ヤフフリ' | 'その他';

export type ItemCondition =
  | '新品' | '再生品' | 'ほぼ新品' | '非常に良い' | '良い' | '可' | 'ジャンク';

export type ItemStatus =
  | '作業中' | '出荷済' | '出品中'
  | '販売済' | '返品処理';

export type WorkStream = 'テレビ' | 'ブルーレイ' | '付属品' | 'その他';

export type TurnoverClass = '高' | '中' | '低';

export type ExpenseCategory = '固定費' | '変動費' | '給与' | '外注費' | '諸経費';

export type WorkStep = 'registered' | 'inspected' | 'cleaned' | 'photo' | 'listing' | 'packed' | 'shipped' | 'inspection_cleaning';

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
  status?: ItemStatus;
  /** 仕入れを伴わない行（Amazon返品の再登録など）では空になる */
  purchaser_id?: string | null;
  deliverer_id?: string | null;
  work_stream?: WorkStream | null;
  purchased_at?: string | null;
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
  source_purchase_draft_id?: string | null;
}

export interface PurchaseDraft {
  id: string;
  marketplace: Marketplace;
  marketplace_item_id: string;
  marketplace_url: string;
  account_label: string;
  title: string;
  purchased_at: string | null;
  cost_amount: number | null;
  product_id: string | null;
  model_no: string | null;
  product_no: number | null;
  asin: string | null;
  planned_price: number | null;
  planned_payout: number | null;
  state: 'draft' | 'registered' | 'dismissed';
  registered_item_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
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
  purchased_at: string | null;
  cost_amount: number;
  marketplace: Marketplace;
  marketplace_url: string | null;
  card_name: string | null;
  purchaser_name: string | null;
  deliverer_name: string | null;
  work_stream: WorkStream | null;
  deliverer_id: string | null;
  purchaser_id: string | null;
  tracking_no: string | null;
  planned_price: number | null;
  planned_payout: number | null;
  sales_channel: SalesChannel | null;
  product_registered: boolean;
  inspected: boolean;
  photo_uploaded: boolean;
  packed_on: string | null;
  shipped_on: string | null;
  listed_on: string | null;
  sold_on: string | null;
  sold_price: number | null;
  payout_amount: number | null;
  amazon_returned_on: string | null;
  refund_amount: number;
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
  model_no: string | null;
  asin: string | null;
  condition: ItemCondition | null;
  purchased_at: string | null;
  marketplace: Marketplace;
  marketplace_item_id: string | null;
  marketplace_url: string | null;
  sold_price: number | null;
  payout_amount: number | null;
  tracking_no: string | null;
  accessories: string | null;
  description: string | null;
  description_template: string | null;
  manufacture_year: number | null;
  cleaned: boolean;
  sales_channel: SalesChannel | null;
  planned_price: number | null;
  deliverer_id: string | null;
  purchaser_name: string | null;
  deliverer_name?: string | null;
  product_registered: boolean;
  inspected: boolean;
  photo_uploaded: boolean;
  packed_on: string | null;
  shipped_on: string | null;
  amazon_returned_on: string | null;
  reference_image_url: string | null;
  photo_count: number;
  last_comment_at: string | null;
  malfunction_reported: boolean;
  malfunction_comment: string | null;
  malfunction_reported_at: string | null;
  malfunction_resolved_at: string | null;
}

export interface ItemComment {
  id: string;
  item_id: string;
  author_id: string;
  body: string;
  created_at: string;
  task_kind?: string | null;
  task_completed_at?: string | null;
  photos?: { id: string; url: string }[];
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
}

export interface DelivererWorkload {
  deliverer_id: string;
  deliverer_name: string;
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
  取引記録リンク: string | null;
}
