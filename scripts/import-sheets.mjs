#!/usr/bin/env node
/**
 * スプレッドシート(CSV) → Supabase 取り込み
 *
 * 元データ
 *   総合管理表「仕入れ販売管理」 … 3,163 行。仕入れから販売・返金まで全部入っている本体
 *   総合管理表「商品リスト」     … 628 件のリサーチ台帳
 *   納品管理表 各担当者シート     … 「付属品」列だけ本体に無いので、SKU で補う
 *
 * 使い方
 *   # 1) xlsx から CSV を作る
 *   python3 scripts/sheets-to-csv.py 総合管理表.xlsx 納品管理表.xlsx --out data
 *
 *   # 2) 中身を確認する（書き込みなし）
 *   node scripts/import-sheets.mjs \
 *     --ledger 'data/総合管理表/仕入れ販売管理.csv' \
 *     --products 'data/総合管理表/商品リスト.csv' \
 *     --accessories 'data/納品管理表/*.csv' \
 *     --dry-run
 *
 *   # 3-a) SQL を書き出して、Supabase の SQL Editor に貼る（CLI 不要）
 *   node scripts/import-sheets.mjs ... --sql data/import.sql
 *
 *   # 3-b) もしくは直接流し込む（service_role キーが要る。手元でだけ実行すること）
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-sheets.mjs ...
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// CSV（引用符と改行入りセルに対応。説明文に改行が入るので自前で処理する）
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** ヘッダー行を探して {列名: 値} の配列にする。列名の改行は空白に潰す。 */
function toRecords(rows, requiredHeader) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const headerIdx = rows.findIndex((r) => r.some((c) => norm(c) === requiredHeader));
  if (headerIdx < 0) return null;
  const header = rows[headerIdx].map(norm);
  return rows.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// 値の正規化
// ---------------------------------------------------------------------------
const num = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[¥￥,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};

const bool = (v) => ['TRUE', 'True', 'true', '1'].includes(String(v ?? '').trim());

/** sheets-to-csv.py が YYYY-MM-DD にそろえているが、手入力の揺れも拾う */
function toDate(v, fallbackYear) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    if (y <= 1900) return null;   // 空の日付がシリアル 0 になったもの
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m && fallbackYear) return `${fallbackYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

/** '&#9;B07ZDDDW1G' のようにタブ実体参照が混ざった ASIN を洗う */
const asin = (v) => {
  const m = /([A-Z0-9]{10})/.exec(String(v ?? '').replace(/&#9;/g, '').toUpperCase());
  return m ? m[1] : null;
};

const clean = (v) => {
  const s = String(v ?? '').replace(/&#9;/g, '').trim();
  return s === '' ? null : s;
};

/** '(テ)株式会社コエル' → { name: '株式会社コエル', stream: 'テレビ' } */
const STREAM_PREFIX = { 'テ': 'テレビ', 'ブ': 'ブルーレイ', '付': '付属品' };
function splitStaffName(raw) {
  const s = String(raw ?? '').trim();
  const m = /^[（(]([^）)]+)[）)]\s*(.+)$/.exec(s);
  if (!m) return { name: s, stream: null };
  return { name: m[2].trim(), stream: STREAM_PREFIX[m[1]] ?? null };
}

const canonName = (s) => String(s ?? '').replace(/\(株\)|（株）/g, '株式会社').replace(/\s+/g, '');

const SKU_RE = /^([0-9]+[a-z]*)-([A-Z]{2,4})-(\d{8})-(\d+)$/;

const MARKETPLACES = new Set([
  'メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'ジモティー',
  'オフモール', '2ndストリート', 'トレジャーファクトリー', '楽天', '店舗', 'Amazon返品', 'その他',
]);
// シート上の表記ゆれを enum に寄せる
const MARKETPLACE_ALIAS = { 'Amazo': 'Amazon返品', 'アマゾン': 'Amazon返品' };

const CONDITIONS = new Set(['新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク']);
const CHANNELS = new Set(['FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他']);

// 「状態」列に混ざっていた進行状態
const STATUS_FROM_STATE = { '返品処理': '返品処理', 'Amazo返品': 'Amazon返品', 'Amazon返品': 'Amazon返品' };
const AMAZON_RETURN_STATES = new Set(['Amazo返品', 'Amazon返品']);

// ---------------------------------------------------------------------------
// SQL 文字列化
// ---------------------------------------------------------------------------
const q = (v) => {
  if (v === null || v === undefined || v === '') return 'null';
  return `'${String(v).replace(/'/g, "''")}'`;
};
const qn = (v) => (v === null || v === undefined || v === '' ? 'null' : String(v));
const qb = (v) => (v ? 'true' : 'false');
const staffRef = (code) => (code ? `(select id from app.staff where code = ${q(code)})` : 'null');

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--ledger') out.ledger = argv[++i];
    else if (a === '--products') out.products = argv[++i];
    else if (a === '--accessories') out.accessories = argv[++i];
    else if (a === '--sql') out.sql = argv[++i];
    else if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--max-bytes') out.maxBytes = Number(argv[++i]);
    else console.warn(`不明な引数: ${a}`);
  }
  return out;
}

function expand(globish) {
  if (!globish) return [];
  if (!globish.includes('*')) {
    return statSync(globish).isDirectory()
      ? readdirSync(globish).filter((f) => f.endsWith('.csv')).map((f) => join(globish, f))
      : [globish];
  }
  const dir = dirname(globish);
  const re = new RegExp('^' + basename(globish).replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
function mapProducts(csvPath, warn) {
  const recs = toRecords(parseCsv(readFileSync(csvPath, 'utf8')), '商品番号');
  if (!recs) throw new Error(`商品リストのヘッダー「商品番号」が見つかりません: ${csvPath}`);

  const out = [];
  const seen = new Set();
  for (const r of recs) {
    const a = asin(r['ASIN']);
    if (!a) {
      // 数式で 'False' や '0' だけが入った空のテンプレート行は黙ってとばす
      const hasContent = [r['型番'], r['メーカー'], r['ジャンル'], r['非常に良い販売']]
        .some((v) => clean(v));
      if (hasContent) {
        warn(`商品リスト: ASIN が無いためとばしました（${clean(r['メーカー']) ?? ''} ${clean(r['型番']) ?? ''} ${clean(r['ジャンル']) ?? ''}）`);
      }
      continue;
    }
    if (seen.has(a)) { warn(`商品リスト: ASIN 重複のためとばしました（${a}）`); continue; }
    seen.add(a);
    out.push({
      product_no: num(r['商品番号']),
      asin: a,
      model_no: clean(r['型番']),
      maker: clean(r['メーカー']),
      genre: clean(r['ジャンル']),
      list_price: num(r['非常に良い販売']),
      payout_estimate: num(r['振込額']),
      target_cost: num(r['仕入れ目標']),
      turnover: ['高', '中', '低'].includes(r['回転']) ? r['回転'] : null,
      has_sold_before: bool(r['売ったことがあるか']),
      monthly_purchase_cap: num(r['月間メルカリ 仕入れ可個数']),
      expected_sales_qty: num(r['見込み販売個数']),
      image_url: clean(r['写真URL']),
      // 元シートの keepaURL は数式の不具合で全 ASIN が連結されており 1 件 6KB ある。
      // その商品の ASIN 1 件だけを指す正しい URL に組み直す。
      keepa_url: `https://graph.keepa.com/pricehistory.png?asin=${a}`,
      memo: clean(r['メモ']),
    });
  }
  return out;
}

/** 納品管理表の各担当者シートから「付属品」だけ拾う（本体シートに無い列） */
function collectAccessories(paths, warn) {
  const map = new Map();
  for (const p of paths) {
    const recs = toRecords(parseCsv(readFileSync(p, 'utf8')), '出品者SKU');
    if (!recs) continue;
    for (const r of recs) {
      const sku = clean(r['出品者SKU']);
      const acc = clean(r['付属品']);
      if (sku && acc && !map.has(sku)) map.set(sku, acc);
    }
  }
  if (map.size === 0) warn('付属品の列が見つかりませんでした（納品管理表の CSV を確認してください）');
  return map;
}

function mapLedger(csvPath, accessories, warn) {
  const recs = toRecords(parseCsv(readFileSync(csvPath, 'utf8')), '出品者SKU');
  if (!recs) throw new Error(`「出品者SKU」のヘッダーが見つかりません: ${csvPath}`);

  const items = [];
  const conflicts = [];
  const seen = new Set();

  for (const r of recs) {
    const sku = clean(r['出品者SKU']);
    if (!sku) continue;

    const m = SKU_RE.exec(sku);
    if (!m) { warn(`SKU の形式が想定外のためとばしました: ${sku}`); continue; }

    const mid = m[2];
    const purchaserCode = mid.length === 4 ? mid.slice(0, 2) : null;
    const delivererCode = mid.length === 4 ? mid.slice(2) : mid;

    const purchasedAt = toDate(r['購入日']);
    const year = purchasedAt?.slice(0, 4);
    const deliv = splitStaffName(r['納品担当者']);

    const rawState = (r['状態'] ?? '').trim();
    const condition = CONDITIONS.has(rawState) ? rawState : null;
    const statusFromState = STATUS_FROM_STATE[rawState] ?? null;

    const soldOn = toDate(r['販売日'], year);
    const rawMarket = (r['仕入れ先'] ?? '').trim();
    const marketplace = MARKETPLACE_ALIAS[rawMarket]
      ?? (MARKETPLACES.has(rawMarket) ? rawMarket : (rawMarket ? 'その他' : 'その他'));

    // 返金は3列に散っているので合算し、内訳は refund_note に残す
    const refunds = [
      ['仕入れ先関連返金', num(r['仕入れ先関連返金'])],
      ['Amazon 一部返金', num(r['Amazon 一部返金'])],
      ['Amazon 在庫払い戻し', num(r['Amazon 在庫払い戻し'])],
    ].filter(([, v]) => v && v > 0);
    const refundAmount = refunds.reduce((s, [, v]) => s + v, 0);

    const plannedPrice = num(r['販売予定価格']);

    const row = {
      sku,
      lot_seq: Number(String(r['通番号'] || m[1]).replace(/\D/g, '')) || null,
      is_accessory: !plannedPrice,
      purchaser_code: purchaserCode,
      deliverer_code: delivererCode,
      work_stream: deliv.stream,
      purchased_at: purchasedAt,
      title: clean(r['商品名']) ?? '（商品名なし）',
      cost_amount: num(r['仕入金額']) ?? 0,
      marketplace,
      marketplace_item_id: clean(r['ID']),
      marketplace_url: clean(r['商品URL (付属品確認)']) ?? clean(r['商品URL']),
      card_name: clean(r['クレカ']),
      tracking_no: clean(r['追跡番号']),
      asin: asin(r['ASIN']),
      condition,
      accessories: accessories.get(sku) ?? null,
      description: clean(r['説明文']),
      planned_price: plannedPrice,
      planned_payout: num(r['振込予定額']),
      sales_channel: CHANNELS.has(r['販売先']) ? r['販売先'] : null,
      product_registered_at: bool(r['商品登録・撮影'] ?? r['商品登録']) ? purchasedAt : null,
      inspected_at: bool(r['検品・清掃'] ?? r['検品・清掃・撮影']) ? purchasedAt : null,
      photo_uploaded_at: bool(r['写真登録']) ? purchasedAt : null,
      packed_on: toDate(r['梱包日'], year),
      shipped_on: toDate(r['出荷日'], year),
      sold_on: soldOn,
      sold_price: soldOn ? num(r['注文価格']) : null,
      payout_amount: soldOn ? num(r['振込金額']) : null,
      refund_amount: refundAmount,
      refund_note: refunds.length ? refunds.map(([k, v]) => `${k}: ¥${v.toLocaleString('ja-JP')}`).join(' / ') : null,
      returned_on: rawState === '返品処理' ? (toDate(r['出荷日'], year) ?? purchasedAt) : null,
      // Amazon から戻ってきた日はシートに無いので、販売日 → 出荷日 → 購入日 の順で推定する。
      // どれも空の行（元シートの日付が丸ごと欠けているもの）は日付を作らず、
      // status だけで「戻ってきた」事実を残す。
      amazon_returned_on: AMAZON_RETURN_STATES.has(rawState)
        ? (soldOn ?? toDate(r['出荷日'], year) ?? purchasedAt)
        : null,
      status_override: statusFromState,
      memo: [clean(r['メモ']), clean(r['仕入担当者→納品担当者コメント']), clean(r['納品担当者→仕入担当者コメント'])]
        .filter(Boolean).join(' / ') || null,
      source_sheet: '仕入れ販売管理',
    };

    // 販売済みなのに金額が無い行は、制約に引っかかるので販売情報を落として警告する
    if (row.sold_on && row.sold_price === null) {
      warn(`販売日はあるが注文価格が空のため、販売情報を保留にしました: ${sku}`);
      row.sold_on = null;
      row.payout_amount = null;
    }

    if (seen.has(sku)) {
      conflicts.push({ sku, reason: '同じ SKU が複数行にありました', payload: row });
      continue;
    }
    seen.add(sku);
    items.push(row);
  }

  return { items, conflicts };
}

// ---------------------------------------------------------------------------
function buildSql(products, items, conflicts) {
  const chunks = [];
  const push = (s) => chunks.push(s);

  push(`-- 物販管理システム — データ取り込み（自動生成）
--
--   商品マスタ ${products.length} 件 / 仕入明細 ${items.length} 件 / 要確認 ${conflicts.length} 件
--
--   先に supabase/setup-all.sql を実行してからこのファイルを流してください。
--   同じ SKU は上書きされないので、二重に流しても件数は増えません。

begin;
`);

  if (products.length) {
    push(`-- ▼ 商品マスタ（総合管理表「商品リスト」）`);
    for (const batch of chunk(products, 200)) {
      push(`insert into app.products
  (product_no, asin, model_no, maker, genre, list_price, payout_estimate, target_cost,
   turnover, has_sold_before, monthly_purchase_cap, expected_sales_qty, image_url, keepa_url, memo)
values`);
      push(batch.map((p) => `  (${qn(p.product_no)}, ${q(p.asin)}, ${q(p.model_no)}, ${q(p.maker)}, ${q(p.genre)}, ` +
        `${qn(p.list_price)}, ${qn(p.payout_estimate)}, ${qn(p.target_cost)}, ` +
        `${p.turnover ? `${q(p.turnover)}::app.turnover_class` : 'null'}, ${qb(p.has_sold_before)}, ` +
        `${qn(p.monthly_purchase_cap)}, ${qn(p.expected_sales_qty)}, ${q(p.image_url)}, ${q(p.keepa_url)}, ${q(p.memo)})`).join(',\n'));
      push(`on conflict (asin) do nothing;\n`);
    }
  }

  const lots = [...new Set(items.map((i) => i.lot_seq).filter(Boolean))].sort((a, b) => a - b);
  if (lots.length) {
    push(`-- ▼ 通番号（ロット）`);
    for (const batch of chunk(lots, 500)) {
      push(`insert into app.lots (seq) values\n${batch.map((s) => `  (${s})`).join(',\n')}\non conflict (seq) do nothing;\n`);
    }
  }

  push(`-- ▼ 仕入明細（総合管理表「仕入れ販売管理」）`);
  for (const batch of chunk(items, 100)) {
    push(`insert into app.items
  (sku, lot_seq, is_accessory, purchaser_id, deliverer_id, work_stream, purchased_at, title,
   cost_amount, marketplace, marketplace_item_id, marketplace_url, card_id, tracking_no,
   product_id, asin, condition, accessories, description, planned_price, planned_payout,
   sales_channel, product_registered_at, inspected_at, photo_uploaded_at, packed_on, shipped_on,
   sold_on, sold_price, payout_amount, refund_amount, refund_note, returned_on,
   amazon_returned_on, status, memo)
values`);
    push(batch.map((i) => '  (' + [
      q(i.sku),
      qn(i.lot_seq),
      qb(i.is_accessory),
      staffRef(i.purchaser_code),
      staffRef(i.deliverer_code),
      i.work_stream ? `${q(i.work_stream)}::app.work_stream` : 'null',
      q(i.purchased_at),
      q(i.title),
      qn(i.cost_amount),
      `${q(i.marketplace)}::app.marketplace`,
      q(i.marketplace_item_id),
      q(i.marketplace_url),
      i.card_name ? `(select id from app.payment_cards where name = ${q(i.card_name)})` : 'null',
      q(i.tracking_no),
      i.asin ? `(select id from app.products where asin = ${q(i.asin)})` : 'null',
      q(i.asin),
      i.condition ? `${q(i.condition)}::app.item_condition` : 'null',
      q(i.accessories),
      q(i.description),
      qn(i.planned_price),
      qn(i.planned_payout),
      i.sales_channel ? `${q(i.sales_channel)}::app.sales_channel` : 'null',
      q(i.product_registered_at),
      q(i.inspected_at),
      q(i.photo_uploaded_at),
      q(i.packed_on),
      q(i.shipped_on),
      q(i.sold_on),
      qn(i.sold_price),
      qn(i.payout_amount),
      qn(i.refund_amount),
      q(i.refund_note),
      q(i.returned_on),
      i.status_override ? `${q(i.status_override)}::app.item_status` : `'仕入済'::app.item_status`,
      q(i.memo),
    ].join(', ') + ')').join(',\n'));
    push(`on conflict (sku) do nothing;\n`);
  }

  if (conflicts.length) {
    push(`-- ▼ 取り込めなかった行（大元アプリで確認して直してください）`);
    for (const batch of chunk(conflicts, 100)) {
      push(`insert into app.import_conflicts (sku, reason, source, payload) values`);
      push(batch.map((c) => `  (${q(c.sku)}, ${q(c.reason)}, ${q(c.payload.source_sheet)}, ${q(JSON.stringify(c.payload))}::jsonb)`).join(',\n'));
      push(`;\n`);
    }
  }

  push(`commit;

-- 確認用
--   select count(*) from app.items;
--   select * from app.v_stock_summary;
--   select * from app.v_monthly_summary order by month desc limit 6;
--   select count(*) from app.v_ledger_gaps;
`);

  return chunks.join('\n');
}


// ---------------------------------------------------------------------------
// CSV 取り込み方式
//   SQL を貼る方式だと説明文のせいで数 MB になり、SQL Editor に何回も貼る羽目になる。
//   そこで「空の受け皿テーブルを作る SQL」→「CSV をアップロード」→「移し替える SQL」
//   の 3 手に分ける。SQL は 2 つとも数 KB で済み、データは 1 回のアップロードで載る。
// ---------------------------------------------------------------------------
const STAGING_ITEM_COLS = [
  'sku', 'lot_seq', 'is_accessory', 'purchaser_code', 'deliverer_code', 'work_stream',
  'purchased_at', 'title', 'cost_amount', 'marketplace', 'marketplace_item_id',
  'marketplace_url', 'card_name', 'tracking_no', 'asin', 'condition', 'accessories',
  'description', 'planned_price', 'planned_payout', 'sales_channel',
  'product_registered_at', 'inspected_at', 'photo_uploaded_at', 'packed_on', 'shipped_on',
  'sold_on', 'sold_price', 'payout_amount', 'refund_amount', 'refund_note', 'returned_on',
  'amazon_returned_on', 'status_override', 'memo',
];

const STAGING_PRODUCT_COLS = [
  'product_no', 'asin', 'model_no', 'maker', 'genre', 'list_price', 'payout_estimate',
  'target_cost', 'turnover', 'has_sold_before', 'monthly_purchase_cap',
  'expected_sales_qty', 'image_url', 'keepa_url', 'memo',
];

function toCsv(cols, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function stagingSql() {
  const text = (cols) => cols.map((c) => `  ${c} text`).join(',\n');
  return `-- 手順1/3: CSV を受け止める空のテーブルを作る
--
--   Supabase の SQL Editor に貼って Run してください。数秒で終わります。
--   ここで作るのは一時的な受け皿です。取り込みが済んだら手順3で消えます。

drop table if exists app.staging_items;
drop table if exists app.staging_products;

create table app.staging_products (
${text(STAGING_PRODUCT_COLS)}
);

create table app.staging_items (
${text(STAGING_ITEM_COLS)}
);

-- ダッシュボードの Table Editor から CSV を読み込めるようにする
grant all on app.staging_items, app.staging_products to authenticated, service_role;
`;
}

function transformSql(productCount, itemCount, conflicts) {
  return `-- 手順3/3: 受け皿から本番のテーブルへ移す
--
--   手順2 で products.csv と items.csv を読み込んだあとに、これを貼って Run してください。
--   同じ SKU / ASIN は上書きしないので、二重に流しても件数は増えません。

begin;

-- ▼ 商品マスタ（${productCount} 件）
insert into app.products
  (product_no, asin, model_no, maker, genre, list_price, payout_estimate, target_cost,
   turnover, has_sold_before, monthly_purchase_cap, expected_sales_qty, image_url, keepa_url, memo)
select
  nullif(product_no, '')::integer,
  asin,
  nullif(model_no, ''),
  nullif(maker, ''),
  nullif(genre, ''),
  nullif(list_price, '')::bigint,
  nullif(payout_estimate, '')::bigint,
  nullif(target_cost, '')::bigint,
  nullif(turnover, '')::app.turnover_class,
  coalesce(nullif(has_sold_before, '')::boolean, false),
  nullif(monthly_purchase_cap, '')::integer,
  nullif(expected_sales_qty, '')::integer,
  nullif(image_url, ''),
  nullif(keepa_url, ''),
  nullif(memo, '')
from app.staging_products
where asin is not null and asin <> ''
on conflict (asin) do nothing;

-- ▼ 通番号（ロット）
insert into app.lots (seq)
select distinct nullif(lot_seq, '')::integer
from app.staging_items
where nullif(lot_seq, '') is not null
on conflict (seq) do nothing;

-- ▼ 仕入明細（${itemCount} 件）
insert into app.items
  (sku, lot_seq, is_accessory, purchaser_id, deliverer_id, work_stream, purchased_at, title,
   cost_amount, marketplace, marketplace_item_id, marketplace_url, card_id, tracking_no,
   product_id, asin, condition, accessories, description, planned_price, planned_payout,
   sales_channel, product_registered_at, inspected_at, photo_uploaded_at, packed_on, shipped_on,
   sold_on, sold_price, payout_amount, refund_amount, refund_note, returned_on,
   amazon_returned_on, status, memo)
select
  s.sku,
  nullif(s.lot_seq, '')::integer,
  coalesce(nullif(s.is_accessory, '')::boolean, false),
  buyer.id,
  deliv.id,
  nullif(s.work_stream, '')::app.work_stream,
  nullif(s.purchased_at, '')::date,
  s.title,
  coalesce(nullif(s.cost_amount, '')::bigint, 0),
  nullif(s.marketplace, '')::app.marketplace,
  nullif(s.marketplace_item_id, ''),
  nullif(s.marketplace_url, ''),
  card.id,
  nullif(s.tracking_no, ''),
  prod.id,
  nullif(s.asin, ''),
  nullif(s.condition, '')::app.item_condition,
  nullif(s.accessories, ''),
  nullif(s.description, ''),
  nullif(s.planned_price, '')::bigint,
  nullif(s.planned_payout, '')::bigint,
  nullif(s.sales_channel, '')::app.sales_channel,
  nullif(s.product_registered_at, '')::timestamptz,
  nullif(s.inspected_at, '')::timestamptz,
  nullif(s.photo_uploaded_at, '')::timestamptz,
  nullif(s.packed_on, '')::date,
  nullif(s.shipped_on, '')::date,
  nullif(s.sold_on, '')::date,
  nullif(s.sold_price, '')::bigint,
  nullif(s.payout_amount, '')::bigint,
  coalesce(nullif(s.refund_amount, '')::bigint, 0),
  nullif(s.refund_note, ''),
  nullif(s.returned_on, '')::date,
  nullif(s.amazon_returned_on, '')::date,
  coalesce(nullif(s.status_override, '')::app.item_status, '仕入済'::app.item_status),
  nullif(s.memo, '')
from app.staging_items s
left join app.staff buyer on buyer.code = nullif(s.purchaser_code, '')
left join app.staff deliv on deliv.code = nullif(s.deliverer_code, '')
left join app.payment_cards card on card.name = nullif(s.card_name, '')
left join app.products prod on prod.asin = nullif(s.asin, '')
on conflict (sku) do nothing;

${conflicts.length ? `-- ▼ 元データで SKU が重複していた行（${conflicts.length} 件）。大元アプリで直してください
insert into app.import_conflicts (sku, reason, source, payload) values
${conflicts.map((c) => `  (${q(c.sku)}, ${q(c.reason)}, ${q(c.payload.source_sheet)}, ${q(JSON.stringify(c.payload))}::jsonb)`).join(',\n')};
` : ''}
-- 受け皿はもう要らないので片付ける
drop table app.staging_items;
drop table app.staging_products;

commit;

-- ▼ 取り込み結果の確認
select
  (select count(*) from app.items)                             as 仕入明細,
  (select count(*) from app.items where sold_on is not null)    as 販売済み,
  (select count(*) from app.products)                          as 商品マスタ,
  (select count(*) from app.v_ledger_gaps)                     as 古物台帳の要確認,
  (select count(*) from app.import_conflicts)                  as 取り込めなかった行;

select * from app.v_stock_summary;
select month, 仕入数, 仕入金額, 販売数, 売上, 粗利益 from app.v_monthly_summary order by month desc limit 6;
`;
}

function* chunk(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/** SQL Editor に貼れるよう、大きすぎるときは分割して書き出す */
function writeSqlFiles(sql, outPath, maxBytes) {
  const statements = sql.split(/\n(?=insert into|begin;|commit;|-- ▼)/);
  const files = [];
  let buf = '';
  const flush = () => { if (buf.trim()) { files.push(buf); buf = ''; } };

  for (const st of statements) {
    if (buf.length + st.length > maxBytes && buf.length > 0) flush();
    buf += st + '\n';
  }
  flush();

  if (files.length === 1) {
    writeFileSync(outPath, files[0]);
    return [outPath];
  }

  // 分割時は各ファイルを独立したトランザクションにする
  const written = [];
  files.forEach((body, n) => {
    const p = outPath.replace(/\.sql$/, '') + `-${String(n + 1).padStart(2, '0')}.sql`;
    const header = `-- データ取り込み ${n + 1}/${files.length}（番号順に実行してください）\n\n`;
    let text = body.replace(/^begin;\s*/m, '').replace(/^commit;\s*/m, '');
    writeFileSync(p, header + 'begin;\n' + text + '\ncommit;\n');
    written.push(p);
  });
  return written;
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const warnings = [];
  const warn = (w) => warnings.push(w);

  const products = args.products ? mapProducts(args.products, warn) : [];
  const accessories = collectAccessories(expand(args.accessories), warn);

  if (!args.ledger) {
    console.error('--ledger（総合管理表「仕入れ販売管理」の CSV）は必須です。');
    process.exit(1);
  }
  const { items, conflicts } = mapLedger(args.ledger, accessories, warn);

  console.log(`商品マスタ      : ${products.length} 件`);
  console.log(`仕入明細        : ${items.length} 件`);
  console.log(`  うち販売済み  : ${items.filter((i) => i.sold_on).length} 件`);
  console.log(`  うち付属品    : ${items.filter((i) => i.is_accessory).length} 件`);
  console.log(`  付属品を補完  : ${items.filter((i) => i.accessories).length} 件`);
  console.log(`要確認（衝突）  : ${conflicts.length} 件`);

  if (args.bundle) {
    mkdirSync(args.bundle, { recursive: true });
    const files = [
      ['01-受け皿を作る.sql', stagingSql()],
      ['products.csv', toCsv(STAGING_PRODUCT_COLS, products)],
      ['items.csv', toCsv(STAGING_ITEM_COLS, items)],
      ['03-本番へ移す.sql', transformSql(products.length, items.length, conflicts)],
    ];
    console.log('\n書き出しました:');
    for (const [name, body] of files) {
      const p = join(args.bundle, name);
      writeFileSync(p, body);
      console.log(`  ${name.padEnd(24)} ${(Buffer.byteLength(body) / 1024).toFixed(0).padStart(6)} KB`);
    }
  } else if (args.sql) {
    const sql = buildSql(products, items, conflicts);
    const written = writeSqlFiles(sql, args.sql, args.maxBytes ?? 900_000);
    console.log(`\nSQL を書き出しました:`);
    for (const p of written) console.log(`  ${p}  (${(statSync(p).size / 1024).toFixed(0)} KB)`);
  } else if (!args.dryRun) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（--sql か --dry-run を使ってください）。');
      process.exit(1);
    }
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(url, key, { db: { schema: 'app' } });

    const staff = new Map();
    const { data: sd, error: se } = await db.from('staff').select('id, code');
    if (se) throw se;
    for (const s of sd) staff.set(s.code, s.id);

    for (const b of chunk(products, 300)) {
      const { error } = await db.from('products').upsert(b, { onConflict: 'asin' });
      if (error) throw error;
    }
    const lots = [...new Set(items.map((i) => i.lot_seq).filter(Boolean))].map((seq) => ({ seq }));
    for (const b of chunk(lots, 500)) {
      const { error } = await db.from('lots').upsert(b, { onConflict: 'seq' });
      if (error) throw error;
    }
    for (const b of chunk(items, 200)) {
      const payload = b.map(({ purchaser_code, deliverer_code, status_override, source_sheet, card_name, ...rest }) => ({
        ...rest,
        purchaser_id: staff.get(purchaser_code) ?? null,
        deliverer_id: staff.get(deliverer_code) ?? null,
        status: status_override ?? undefined,
      }));
      const { error } = await db.from('items').upsert(payload, { onConflict: 'sku' });
      if (error) throw error;
    }
    console.log('\n取り込みました。');
  }

  if (warnings.length) {
    const counts = warnings.reduce((m, w) => {
      const k = w.replace(/:.*$/, '');
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    console.log(`\n要確認 ${warnings.length} 件:`);
    for (const [k, n] of Object.entries(counts)) console.log(`  ${n.toString().padStart(4)} × ${k}`);
    console.log('\n  例:');
    for (const w of warnings.slice(0, 8)) console.log(`    - ${w}`);
  }
  if (args.dryRun) console.log('\n--dry-run のため、書き込みはしていません。');
}

main().catch((e) => { console.error(e); process.exit(1); });
