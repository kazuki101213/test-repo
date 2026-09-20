/**
 * 取得した追跡番号を Google スプレッドシートに書き戻す。
 *
 * 認証はサービスアカウント。googleapis を入れずに、
 * Node 標準の crypto で JWT を作ってアクセストークンと交換する。
 *
 * 準備（初回だけ）
 *   1. Google Cloud でサービスアカウントを作り、JSON キーをダウンロードする
 *   2. Google Sheets API を有効にする
 *   3. スプレッドシートを、そのサービスアカウントのメールアドレスに
 *      「編集者」で共有する（これを忘れると 403 になる）
 *   4. .env に GOOGLE_SERVICE_ACCOUNT_JSON=... とパスを書く
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** サービスアカウント JSON からアクセストークンを取る */
export async function getAccessToken(keyPath) {
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error(`${keyPath} がサービスアカウントのキーではありません`);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(key.private_key))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`トークン取得に失敗: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sheetsApi(token, path, init = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

const colName = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

/**
 * 既存シートの商品ID列と突き合わせて、追跡番号・配送状況の列を埋める。
 *
 * @param rows スクレイパーの出力（ヘッダ行を除く）。[商品ID, プラットフォーム, 追跡番号, 配送業者, 確度, 配送状況, ...]
 * @returns {{updated:number, notFound:string[]}}
 */
export function buildUpdates(sheetValues, rows) {
  const header = sheetValues[0] || [];
  const idCol = header.indexOf('商品ID');
  if (idCol < 0) throw new Error('シートに「商品ID」という見出しの列がありません');

  // 追跡番号・配送状況の列。無ければ右端に足す。
  let trackCol = header.indexOf('追跡番号');
  let statusCol = header.indexOf('配送状況');
  const newHeaders = [];
  if (trackCol < 0) { trackCol = header.length + newHeaders.length; newHeaders.push([trackCol, '追跡番号']); }
  if (statusCol < 0) { statusCol = header.length + newHeaders.length; newHeaders.push([statusCol, '配送状況']); }

  // 商品ID → 行番号（0 始まり、ヘッダ込み）
  const rowOf = new Map();
  for (let r = 1; r < sheetValues.length; r++) {
    const id = (sheetValues[r][idCol] || '').toString().trim();
    if (id) rowOf.set(id, r);
  }

  const data = [];
  const notFound = [];
  let updated = 0;

  for (const [colIdx, label] of newHeaders) {
    data.push({ range: `${colName(colIdx)}1`, values: [[label]] });
  }

  for (const row of rows) {
    const [id, , tracking, , , status] = row;
    const r = rowOf.get((id || '').trim());
    if (r == null) { notFound.push(id); continue; }
    if (!tracking && !status) continue;

    const a1 = r + 1; // A1 表記は 1 始まり
    if (tracking) data.push({ range: `${colName(trackCol)}${a1}`, values: [[tracking]] });
    if (status) data.push({ range: `${colName(statusCol)}${a1}`, values: [[status]] });
    updated++;
  }

  return { data, updated, notFound };
}

/** シートを読み、突き合わせて、書き戻す */
export async function writeTracking({ keyPath, spreadsheetId, sheetName, rows }) {
  const token = await getAccessToken(keyPath);

  const range = encodeURIComponent(`${sheetName}!A1:ZZ`);
  const current = await sheetsApi(token, `${spreadsheetId}/values/${range}`);
  const { data, updated, notFound } = buildUpdates(current.values || [], rows);

  if (data.length === 0) return { updated: 0, notFound };

  await sheetsApi(token, `${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: data.map((d) => ({ ...d, range: `${sheetName}!${d.range}` })),
    }),
  });

  return { updated, notFound };
}
