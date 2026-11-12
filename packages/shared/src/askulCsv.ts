export const askulCsvMaxBytes = 12 * 1024 * 1024;
export const askulExpenseBatchSize = 250;

export type AskulExpenseInput = {
  id: string;
  incurred_on: string;
  category: '変動費';
  name: string;
  amount: number;
  card_id: null;
  staff_id: string | null;
  memo: string;
};

const requiredColumns = {
  date: '出荷日',
  name: '注文時商品名',
  amount: '小計金額(税込)',
  order: '出荷オーダーNo',
  line: '出荷オーダー行No',
};
const addressColumns = ['注文時お届け先住所1', '注文時お届け先住所2', '注文時お届け先住所3'];

export function normalizeAskulDeliveryAddress(value: string) {
  return value.normalize('NFKC').replace(/^\s*〒\s*\d{3}[-‐–−]?\d{4}\s*/, '')
    .replace(/\s+/g, '').replace(/[‐‑‒–—―−]/g, '-')
    .replace(/(\d)(?:丁目|番地|番|号)(?=\d)/g, '$1-')
    .replace(/(\d)(?:番地|番|号)(?=\D|$)/g, '$1');
}

export function findAskulDeliveryAssignee(address: string, profiles: readonly { staff_id: string; address: string }[]) {
  const key = normalizeAskulDeliveryAddress(address);
  if (!key) return null;
  const ids = new Set(profiles.filter(profile => normalizeAskulDeliveryAddress(profile.address) === key)
    .map(profile => profile.staff_id));
  return ids.size === 1 ? ids.values().next().value ?? null : null;
}

function decodeCsv(bytes: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'field' | 'quoted' | 'closed' = 'field';

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (state === 'quoted') {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += char;
        index++;
      } else state = 'closed';
      continue;
    }
    if (char === ',' || char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      state = 'field';
      if (char === ',') continue;
      if (char === '\r' && text[index + 1] === '\n') index++;
      rows.push(row);
      row = [];
    } else if (char === '"' && state === 'field' && !field) {
      state = 'quoted';
    } else if (char === '"' || state === 'closed') {
      throw new Error('CSVの引用符の形式を確認してください。');
    } else {
      field += char;
    }
  }

  if (state === 'quoted') throw new Error('CSVの引用符が閉じていません。');
  if (field || row.length || state === 'closed') rows.push([...row, field]);
  return rows;
}

const normalize = (value: string) => value.trim().normalize('NFKC');
const sourceNumber = (value: string) => normalize(value).replace(/^'/, '').toUpperCase();

function dateFromCsv(value: string) {
  const parts = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(normalize(value));
  if (!parts) return null;
  const [, year = "", month = "", day = ""] = parts;
  const date = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
  const millis = Date.parse(date);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === date ? date : null;
}

async function expenseId(order: string, line: string) {
  const key = JSON.stringify(['askul-expense-v1', order, line]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export async function parseAskulExpenseReport(bytes: ArrayBuffer) {
  if (bytes.byteLength === 0 || bytes.byteLength > askulCsvMaxBytes) throw new Error('12 MB以内のCSVを選択してください。');
  const [headers, ...body] = parseCsv(decodeCsv(bytes));
  const names = headers?.map(value => normalize(value).replace(/^\uFEFF/, '')) ?? [];
  const addressIndices = addressColumns.map(name => names.indexOf(name));
  const hasDeliveryAddresses = addressIndices.some(index => index >= 0);
  if (hasDeliveryAddresses && addressIndices.some((index, column) => index < 0
      || names.lastIndexOf(addressColumns[column] ?? '') !== index)) {
    throw new Error('注文時お届け先住所1・2・3の列を確認してください。');
  }
  const indices = Object.fromEntries(Object.entries(requiredColumns).map(([key, name]) => {
    const first = names.indexOf(name);
    if (first === -1 || names.lastIndexOf(name) !== first) throw new Error('CSVの列「' + name + '」を確認してください。');
    return [key, first];
  })) as Record<keyof typeof requiredColumns, number>;
  const rows = body.filter(row => row.some(value => value.trim()));
  if (!rows.length || rows.length > 20_000) throw new Error('CSVに1〜20,000行の明細が必要です。');

  const seen = new Set<string>();
  const expenses = rows.map((row, index) => {
    const invalid = () => new Error('明細' + (index + 1) + '行目の出荷日、商品名、税込小計、出荷オーダー番号を確認してください。');
    if (row.length !== names.length) throw invalid();
    const date = dateFromCsv(row[indices.date] ?? "");
    const name = (row[indices.name] ?? "").trim();
    const rawAmount = normalize(row[indices.amount] ?? "");
    const amount = Number(rawAmount.replaceAll(',', ''));
    const order = sourceNumber(row[indices.order] ?? "");
    const line = sourceNumber(row[indices.line] ?? "");
    if (!date || !name || name.length > 200 || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(rawAmount)
        || !Number.isSafeInteger(amount) || !/^[A-Z0-9-]{1,48}$/.test(order) || !/^\d{1,12}$/.test(line)) throw invalid();
    const canonicalLine = String(Number(line));
    const key = order + '/' + canonicalLine;
    if (seen.has(key)) throw new Error('CSV内で同じ出荷オーダー番号・行番号が重複しています。明細' + (index + 1) + '行目を確認してください。');
    seen.add(key);
    const address = hasDeliveryAddresses ? addressIndices.map(column => row[column]?.trim() ?? '')
      .map(value => value.replace(/^'/, '')).join('') : '';
    return { date, name, amount, order, line: canonicalLine, address };
  });
  const inputs = await Promise.all(expenses.map(async (row): Promise<AskulExpenseInput> => ({
    id: await expenseId(row.order, row.line),
    incurred_on: row.date,
    category: '変動費',
    name: row.name,
    amount: row.amount,
    card_id: null,
    staff_id: null,
    memo: 'アスクル ' + row.order + '/' + row.line,
  })));
  return { rows: inputs, deliveryAddresses: hasDeliveryAddresses ? expenses.map(row => row.address) : null };
}

export async function parseAskulExpenseCsv(bytes: ArrayBuffer): Promise<AskulExpenseInput[]> {
  return (await parseAskulExpenseReport(bytes)).rows;
}
