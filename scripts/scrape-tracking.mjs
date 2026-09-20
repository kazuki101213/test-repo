#!/usr/bin/env node
/**
 * メルカリ / ヤフオク / ヤフフリ / ラクマ の購入取引から追跡番号を集める
 *
 * 各社とも購入者向けの公開 API が無いので、ログイン済みのブラウザで
 * 取引ページを開いて拾う。パスワードはこのスクリプトでは一切扱わない。
 * 最初に一度だけ手でログインしてもらい、そのプロファイル（Cookie）を使い回す。
 *
 *   ┌─ 1) ログイン（初回と、セッションが切れたとき）
 *   │    node scripts/scrape-tracking.mjs --login
 *   │    → ブラウザが開くので 4 サイトに手でログインして、ターミナルで Enter
 *   │
 *   ├─ 2) 取得
 *   │    node scripts/scrape-tracking.mjs --out data/tracking.csv
 *   │
 *   └─ 3) スプレッドシートの商品IDに絞りたいとき
 *        node scripts/scrape-tracking.mjs --ids data/メルカリ自動抽出.csv
 *
 * ページ構造が変わって拾えなくなったら --dump を付けると
 * data/dump/ に HTML と本文テキストが落ちるので、そこから直せる。
 *
 *   node scripts/scrape-tracking.mjs --sites メルカリ --limit 1 --dump
 *
 * 注意
 *   - 各社の利用規約は自動アクセスを禁止している。自分のアカウントの
 *     自分の取引を対象にする前提で、--delay を短くしすぎないこと。
 *   - らくらくメルカリ便 / おてがる配送などの匿名配送は、そもそも購入者に
 *     伝票番号を開示しない。その場合は追跡番号が空、配送状況だけ埋まる。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { SITES, SITE_NAMES, extractTracking, extractStatus } from './lib/tracking-sites.mjs';

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opt = {
    login: false,
    dump: false,
    headed: false,
    sites: SITE_NAMES,
    out: 'data/tracking.csv',
    ids: '',
    profile: 'data/browser-profile',
    limit: 0,
    delay: 2500,
    browserPath: '',
    sheetId: process.env.TRACKING_SPREADSHEET_ID || '',
    sheetName: 'メルカリ自動抽出',
    saKey: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--login') opt.login = true;
    else if (a === '--dump') opt.dump = true;
    else if (a === '--headed') opt.headed = true;
    else if (a === '--out') opt.out = next();
    else if (a === '--ids') opt.ids = next();
    else if (a === '--profile') opt.profile = next();
    else if (a === '--browser-path') opt.browserPath = next();
    else if (a === '--sheet-id') opt.sheetId = next();
    else if (a === '--sheet-name') opt.sheetName = next();
    else if (a === '--sa-key') opt.saKey = next();
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--limit') opt.limit = Number(next());
    else if (a === '--delay') opt.delay = Number(next());
    else if (a === '--sites') opt.sites = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`不明な引数: ${a}`); process.exit(1); }
  }
  const unknown = opt.sites.filter((s) => !SITES[s]);
  if (unknown.length) {
    console.error(`--sites が不正です: ${unknown.join(', ')}`);
    console.error(`使えるのは: ${SITE_NAMES.join(', ')}`);
    process.exit(1);
  }
  return opt;
}

function printHelp() {
  console.log(`
使い方
  node scripts/scrape-tracking.mjs --login          初回ログイン（ブラウザが開く）
  node scripts/scrape-tracking.mjs                  全サイトから追跡番号を取得

オプション
  --sites <名前,...>  対象サイト（既定: ${SITE_NAMES.join(',')}）
  --ids <csv>         この CSV に載っている商品IDだけに絞る
  --out <csv>         出力先（既定: data/tracking.csv）
  --limit <n>         1 サイトあたりの取引件数の上限（動作確認用）
  --delay <ms>        ページ遷移の間隔（既定: 2500）
  --dump              HTML と本文を data/dump/ に保存する
  --headed            ブラウザを表示したまま実行する
  --profile <dir>     ログイン情報を置くディレクトリ（既定: data/browser-profile）
  --browser-path <p>  使う Chromium の実行ファイル（PLAYWRIGHT_CHROMIUM_PATH でも可）

スプレッドシートへ書き戻す場合
  --sheet-id <id>     スプレッドシートID（TRACKING_SPREADSHEET_ID でも可）
  --sheet-name <名前> 書き込み先シート（既定: メルカリ自動抽出）
  --sa-key <json>     サービスアカウントの鍵（GOOGLE_SERVICE_ACCOUNT_JSON でも可）
  --dry-run           シートには書かず、書き込む内容だけ表示する
`);
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}

/** --ids で渡された CSV から商品IDらしき列を拾う */
function readWantedIds(path) {
  if (!existsSync(path)) {
    console.error(`--ids のファイルが見つかりません: ${path}`);
    process.exit(1);
  }
  const text = readFileSync(path, 'utf8');
  const ids = new Set();
  // m1234567890（メルカリ）/ n1212071910（ヤフオク・ヤフフリ）の形を全部拾う
  for (const hit of text.matchAll(/\b([a-z]\d{8,12})\b/g)) ids.add(hit[1]);
  return ids;
}

// ---------------------------------------------------------------------------
// ブラウザ
// ---------------------------------------------------------------------------
async function openBrowser(opt, { headed }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright が入っていません。次を実行してください:');
    console.error('  pnpm add -D -w playwright');
    process.exit(1);
  }

  mkdirSync(opt.profile, { recursive: true });

  // 永続プロファイル。手でログインした Cookie がここに残るので、
  // 2 回目以降はログイン不要になる。
  const launch = {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };

  // Playwright が抱えている Chromium と、手元にある Chromium のビルドが
  // 食い違うことがある。その場合は実行ファイルを直接指定して回避する。
  const exe = opt.browserPath || process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (exe) launch.executablePath = exe;

  return chromium.launchPersistentContext(opt.profile, launch);
}

// ---------------------------------------------------------------------------
// 1) ログイン
// ---------------------------------------------------------------------------
async function runLogin(opt) {
  console.log('ブラウザを開きます。表示された各サイトで手動ログインしてください。');
  console.log('（2 段階認証もここで通してください。パスワードはこのスクリプトには渡りません）\n');

  const ctx = await openBrowser(opt, { headed: true });

  for (const name of opt.sites) {
    const page = await ctx.newPage();
    await page.goto(SITES[name].listUrls[0], { waitUntil: 'domcontentloaded' }).catch(() => {});
    console.log(`  - ${name}: タブを開きました`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\n全サイトのログインが終わったら Enter を押してください...');
  rl.close();

  // ログインできているか確認しておく
  console.log('\nログイン状態を確認します。');
  for (const name of opt.sites) {
    const site = SITES[name];
    const page = await ctx.newPage();
    try {
      await page.goto(site.listUrls[0], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1500);
      const text = await page.evaluate(() => document.body.innerText);
      console.log(`  ${site.loginCheck(text) ? '✓' : '✗ 未ログインの可能性'} ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
    }
    await page.close();
  }

  await ctx.close();
  console.log(`\nログイン情報を ${opt.profile} に保存しました。`);
}

// ---------------------------------------------------------------------------
// 2) 取得
// ---------------------------------------------------------------------------
async function collectTransactionUrls(page, site, opt) {
  const urls = new Set();

  for (const listUrl of site.listUrls) {
    try {
      await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      console.log(`    一覧を開けませんでした (${listUrl}): ${e.message}`);
      continue;
    }
    // SPA なので描画を待つ
    await sleep(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(1500);

    const found = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel))
        .map((a) => a.href)
        .filter(Boolean);
    }, site.linkSelector);

    for (const u of found) if (site.linkPattern.test(u)) urls.add(u);
    await sleep(opt.delay);
  }

  return Array.from(urls);
}

async function scrapeSite(ctx, name, opt, wantedIds, rows) {
  const site = SITES[name];
  console.log(`\n[${name}]`);

  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  // ログイン確認
  try {
    await page.goto(site.listUrls[0], { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const text = await page.evaluate(() => document.body.innerText);
    if (!site.loginCheck(text)) {
      console.log('  未ログインです。--login でログインし直してください。');
      await page.close();
      return;
    }
  } catch (e) {
    console.log(`  一覧ページを開けませんでした: ${e.message}`);
    await page.close();
    return;
  }

  let urls = await collectTransactionUrls(page, site, opt);
  console.log(`  取引ページ ${urls.length} 件`);
  if (opt.limit > 0) urls = urls.slice(0, opt.limit);

  for (const [i, url] of urls.entries()) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(2500);

      const html = await page.content();
      const text = await page.evaluate(() => document.body.innerText);
      const itemId = site.itemIdFrom(html);

      if (opt.dump) {
        const base = join('data/dump', site.key, String(i + 1).padStart(3, '0'));
        ensureDir(base + '.html');
        writeFileSync(base + '.html', html);
        writeFileSync(base + '.txt', `URL: ${url}\n商品ID: ${itemId}\n\n${text}`);
      }

      // --ids で絞っている場合、対象外はスキップ
      if (wantedIds && itemId && !wantedIds.has(itemId)) {
        await sleep(opt.delay);
        continue;
      }

      const tracking = extractTracking(text);
      const status = extractStatus(text);

      rows.push([
        itemId || '(商品ID不明)',
        name,
        tracking ? tracking.number : '',
        tracking ? tracking.carrier : '',
        tracking ? tracking.confidence : '',
        status,
        url,
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      ]);

      const mark = tracking ? tracking.number : (status ? `(番号なし/${status})` : '(取得できず)');
      console.log(`  ${String(i + 1).padStart(3)}/${urls.length} ${itemId || '?'} → ${mark}`);
    } catch (e) {
      console.log(`  ${String(i + 1).padStart(3)}/${urls.length} 失敗: ${e.message}`);
    }
    await sleep(opt.delay);
  }

  await page.close();
}

async function runScrape(opt) {
  const wantedIds = opt.ids ? readWantedIds(opt.ids) : null;
  if (wantedIds) console.log(`対象の商品ID: ${wantedIds.size} 件（${opt.ids}）`);

  const ctx = await openBrowser(opt, { headed: opt.headed });
  const rows = [[
    '商品ID', 'プラットフォーム', '追跡番号', '配送業者', '確度', '配送状況', '取引URL', '取得日時',
  ]];

  for (const name of opt.sites) {
    await scrapeSite(ctx, name, opt, wantedIds, rows);
  }

  await ctx.close();

  ensureDir(opt.out);
  writeFileSync(opt.out, toCsv(rows));

  const got = rows.slice(1).filter((r) => r[2]).length;
  console.log(`\n取引 ${rows.length - 1} 件中 ${got} 件で追跡番号を取得。`);
  console.log(`→ ${opt.out}`);
  if (got < rows.length - 1) {
    console.log('番号が空の行は匿名配送の可能性が高いです（購入者に伝票番号が開示されない）。');
  }

  if (opt.sheetId) await writeBackToSheet(opt, rows.slice(1));
  else console.log('\n--sheet-id を付けるとスプレッドシートに直接書き込みます。');
}

// ---------------------------------------------------------------------------
// 3) スプレッドシートへ書き戻す
// ---------------------------------------------------------------------------
async function writeBackToSheet(opt, rows) {
  if (!opt.saKey) {
    console.error('\nサービスアカウントの鍵が指定されていません（--sa-key / GOOGLE_SERVICE_ACCOUNT_JSON）。');
    return;
  }

  const { writeTracking, getAccessToken, buildUpdates } = await import('./lib/sheets-write.mjs');

  if (opt.dryRun) {
    // シートは読むが書かない
    const token = await getAccessToken(opt.saKey);
    const range = encodeURIComponent(`${opt.sheetName}!A1:ZZ`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${opt.sheetId}/values/${range}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) { console.error(`シートを読めません: ${res.status} ${await res.text()}`); return; }
    const { data, updated, notFound } = buildUpdates((await res.json()).values || [], rows);
    console.log(`\n[dry-run] ${updated} 行を更新します（書き込みはしていません）`);
    for (const d of data) console.log(`  ${opt.sheetName}!${d.range} = ${JSON.stringify(d.values[0][0])}`);
    if (notFound.length) console.log(`  シートに無い商品ID: ${notFound.join(', ')}`);
    return;
  }

  console.log(`\nスプレッドシートに書き込みます（${opt.sheetName}）...`);
  try {
    const { updated, notFound } = await writeTracking({
      keyPath: opt.saKey,
      spreadsheetId: opt.sheetId,
      sheetName: opt.sheetName,
      rows,
    });
    console.log(`  ${updated} 行を更新しました。`);
    if (notFound.length) console.log(`  シートに無い商品ID ${notFound.length} 件: ${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? ' ...' : ''}`);
  } catch (e) {
    console.error(`  書き込みに失敗: ${e.message}`);
    console.error('  スプレッドシートをサービスアカウントのメールアドレスに「編集者」で共有しているか確認してください。');
  }
}

// ---------------------------------------------------------------------------
const opt = parseArgs(process.argv);
if (opt.login) await runLogin(opt);
else await runScrape(opt);
