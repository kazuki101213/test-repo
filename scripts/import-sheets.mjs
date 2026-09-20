#!/usr/bin/env node
/**
 * スプレッドシート → Supabase 移行スクリプト
 *
 * 使い方
 *   1) 総合管理表の「商品リスト」シートを CSV で書き出す      → data/products.csv
 *   2) 納品管理表の担当者シートをそれぞれ CSV で書き出す      → data/items/*.csv
 *   3) .env に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を置く
 *   4) node scripts/import-sheets.mjs --products data/products.csv --items 'data/items/*.csv'
 *
 * 安全のため、まずは --dry-run で件数と警告だけを見ること。
 * service_role キーは RLS を無視するので、このスクリプトはローカルでのみ実行する。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// CSV パーサ（引用符と改行入りセルに対応。説明文に改行が入るので自前で処理する）
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

/** ヘッダー行を見つけて、{列名: 値} の配列にする */
function toRecords(rows, requiredHeader) {
  const headerIdx = rows.findIndex((r) => r.some((c) => c.trim() === requiredHeader));
  if (headerIdx < 0) throw new Error(`ヘッダー列「${requiredHeader}」が見つかりません`);
  const header = rows[headerIdx].map((h) => h.trim());
  return rows.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// 値の正規化
// ---------------------------------------------------------------------------
const yen = (v) => {
  if (!v) return null;
  const n = Number(String(v).replace(/[¥￥,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};

const bool = (v) => String(v).trim().toUpperCase() === 'TRUE';

/** '2025/09/15' '2025-09-15' '9/25' などを YYYY-MM-DD にする */
function toDate(v, fallbackYear) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split(/[-/]/).map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // 「9/25」のように年が省略されている列（梱包日・出荷日）は購入日の年で補う
  if (/^\d{1,2}[-/]\d{1,2}$/.test(s) && fallbackYear) {
    const [m, d] = s.split(/[-/]/).map(Number);
    return `${fallbackYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** '&#9;B07ZDDDW1G' のようにタブ実体参照が混ざっている ASIN を洗う */
const asin = (v) => {
  const m = /([A-Z0-9]{10})/.exec(String(v ?? '').replace(/&#9;/g, '').toUpperCase());
  return m ? m[1] : null;
};

/**
 * 担当者名の接頭辞は「人」ではなく「作業ライン」を表していた。
 *   (テ)株式会社コエル → { name: '株式会社コエル', stream: 'テレビ' }
 */
const STREAM_PREFIX = { 'テ': 'テレビ', 'ブ': 'ブルーレイ', '付': '付属品' };

function splitStaffName(raw) {
  const s = String(raw ?? '').trim();
  const m = /^[（(]([^）)]+)[）)]\s*(.+)$/.exec(s);
  if (!m) return { name: s, stream: null };
  const stream = STREAM_PREFIX[m[1]] ?? null;
  // (石) のように担当者名が入っている接頭辞は、作業ラインではないので捨てる
  return { name: m[2].trim(), stream };
}

/** 会社名の表記ゆれ（(株) と 株式会社）を寄せる */
const canonName = (s) => s.replace(/\(株\)|（株）/g, '株式会社').replace(/\s+/g, '');

const MARKETPLACES = new Set(['メルカリ', 'ヤフオク', 'ヤフフリ', 'PayPayフリマ', 'ラクマ', 'オフモール', '店舗', 'その他']);
const CONDITIONS = new Set(['新品', '再生品', 'ほぼ新品', '非常に良い', '良い', '可', 'ジャンク']);
const CHANNELS = new Set(['FBA', '自己発送', 'メルカリ', 'ヤフオク', 'ヤフフリ', 'その他']);

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { items: [], dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--products') out.products = argv[++i];
    else if (a === '--items') out.itemsGlob = argv[++i];
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
  const pattern = new RegExp('^' + basename(globish).replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
  return readdirSync(dir).filter((f) => pattern.test(f)).map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!args.dryRun && (!url || !key)) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です（--dry-run なら不要）。');
    process.exit(1);
  }

  // --dry-run だけなら Supabase クライアントを読み込まずに動かせるようにする
  let db = null;
  if (!args.dryRun) {
    const { createClient } = await import('@supabase/supabase-js');
    db = createClient(url, key, { db: { schema: 'app' } });
  }
  const warnings = [];

  // ── スタッフのコード表を読む（SKU から担当者を特定するのに使う） ────────
  let staffByCode = new Map();
  let staffByName = new Map();
  if (db) {
    const { data, error } = await db.from('staff').select('id, code, name');
    if (error) throw error;
    for (const s of data) {
      staffByCode.set(s.code, s);
      staffByName.set(canonName(s.name), s);
    }
  }

  // ── 商品マスタ ────────────────────────────────────────────────────────
  if (args.products) {
    const rows = toRecords(parseCsv(readFileSync(args.products, 'utf8')), '商品番号');
    const products = [];
    for (const r of rows) {
      const a = asin(r['ASIN']);
      if (!a) { warnings.push(`商品リスト: ASIN が読めない行をとばしました（商品番号 ${r['商品番号']}）`); continue; }
      products.push({
        product_no: Number(r['商品番号']) || null,
        asin: a,
        model_no: r['型番'] || null,
        maker: r['メーカー'] || null,
        genre: r['ジャンル'] || null,
        list_price: yen(r['非常に良い販売']),
        payout_estimate: yen(r['振込額']),
        target_cost: yen(r['仕入れ目標']),
        turnover: ['高', '中', '低'].includes(r['回転']) ? r['回転'] : null,
        has_sold_before: bool(r['売ったことがあるか']),
        monthly_purchase_cap: Number(r['月間メルカリ 仕入れ可個数']) || null,
        expected_sales_qty: Number(r['見込み販売個数']) || null,
        image_url: r['写真URL'] || null,
        keepa_url: r['keepaURL'] || null,
        memo: r['メモ'] || null,
      });
    }
    console.log(`商品マスタ: ${products.length} 件`);
    if (db) {
      for (const chunk of chunks(products, 500)) {
        const { error } = await db.from('products').upsert(chunk, { onConflict: 'asin' });
        if (error) throw error;
      }
    }
  }

  // ── 仕入明細 ──────────────────────────────────────────────────────────
  const files = expand(args.itemsGlob);
  let total = 0;
  const seenSku = new Set();

  for (const file of files) {
    const rows = toRecords(parseCsv(readFileSync(file, 'utf8')), '出品者SKU');
    const items = [];

    for (const r of rows) {
      const sku = (r['出品者SKU'] ?? '').trim();
      if (!sku) continue;
      if (seenSku.has(sku)) { warnings.push(`SKU 重複のためとばしました: ${sku}`); continue; }
      seenSku.add(sku);

      const purchasedAt = toDate(r['購入日']);
      if (!purchasedAt) { warnings.push(`購入日が読めないためとばしました: ${sku}`); continue; }
      const year = purchasedAt.slice(0, 4);

      const buyer = splitStaffName(r['仕入担当者']);
      const deliv = splitStaffName(r['納品担当者']);
      const purchaser = staffByName.get(canonName(buyer.name));
      const deliverer = staffByName.get(canonName(deliv.name));

      if (db && !purchaser) { warnings.push(`仕入担当者「${buyer.name}」が staff に未登録: ${sku}`); continue; }
      if (db && deliv.name && !deliverer) warnings.push(`納品担当者「${deliv.name}」が staff に未登録: ${sku}`);

      // 「状態」列には品質と '返品処理' が混在していたので分離する
      const rawState = r['状態'] ?? '';
      const condition = CONDITIONS.has(rawState) ? rawState : null;
      const returned = rawState === '返品処理';

      const lotSeq = Number(String(r['通番号'] ?? sku.split('-')[0]).replace(/\D/g, '')) || null;
      const cost = yen(r['仕入金額']) ?? 0;
      const shippedOn = toDate(r['出荷日'], year);

      items.push({
        sku,
        lot_seq: lotSeq,
        // 販売予定価格が空 or ¥0 の行は、本体に買い足した付属品
        is_accessory: !yen(r['販売予定価格']),
        purchaser_id: purchaser?.id ?? null,
        deliverer_id: deliverer?.id ?? null,
        work_stream: deliv.stream,
        purchased_at: purchasedAt,
        title: r['商品名'] || '（商品名なし）',
        cost_amount: cost,
        marketplace: MARKETPLACES.has(r['仕入れ先']) ? r['仕入れ先'] : 'その他',
        marketplace_item_id: r['ID'] ? String(r['ID']).replace(/&#9;/g, '').trim() : null,
        marketplace_url: r['商品URL'] || null,
        tracking_no: r['追跡番号'] ? String(r['追跡番号']).replace(/&#9;/g, '').trim() : null,
        asin: asin(r['ASIN']),
        condition,
        accessories: r['付属品'] || null,
        description: r['説明文'] || null,
        planned_price: yen(r['販売予定価格']),
        planned_payout: yen(r['振込予定額']),
        sales_channel: CHANNELS.has(r['販売先']) ? r['販売先'] : null,
        product_registered_at: bool(r['商品登録・撮影'] ?? r['商品登録']) ? `${purchasedAt}T00:00:00Z` : null,
        inspected_at: bool(r['検品・清掃'] ?? r['検品・清掃・撮影']) ? `${purchasedAt}T00:00:00Z` : null,
        photo_uploaded_at: bool(r['写真登録']) ? `${purchasedAt}T00:00:00Z` : null,
        packed_on: toDate(r['梱包日'], year),
        shipped_on: shippedOn,
        returned_on: returned ? (shippedOn ?? purchasedAt) : null,
        memo: [r['仕入担当者→納品担当者コメント'], r['納品担当者→仕入担当者コメント']]
          .filter(Boolean).join(' / ') || null,
      });
    }

    console.log(`${basename(file)}: ${items.length} 件`);
    if (args.dryRun && items[0]) {
      console.log('  1 行目の変換結果:');
      console.log(JSON.stringify(items[0], null, 2).split('\n').map((l) => '  ' + l).join('\n'));
    }
    total += items.length;

    if (db && items.length > 0) {
      // lots を先に作っておく（items のトリガーでも作られるが、まとめた方が速い）
      const lots = [...new Set(items.map((i) => i.lot_seq).filter(Boolean))].map((seq) => ({ seq }));
      const { error: lotErr } = await db.from('lots').upsert(lots, { onConflict: 'seq' });
      if (lotErr) throw lotErr;

      for (const chunk of chunks(items, 200)) {
        const { error } = await db.from('items').upsert(chunk, { onConflict: 'sku' });
        if (error) throw error;
      }
    }
  }

  console.log(`\n仕入明細 合計: ${total} 件`);
  if (warnings.length > 0) {
    console.log(`\n要確認 ${warnings.length} 件:`);
    for (const w of warnings.slice(0, 50)) console.log(`  - ${w}`);
    if (warnings.length > 50) console.log(`  … 他 ${warnings.length - 50} 件`);
  }
  if (args.dryRun) console.log('\n--dry-run のため、書き込みはしていません。');
}

function* chunks(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

main().catch((e) => { console.error(e); process.exit(1); });
