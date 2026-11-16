export const reportType = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
export const removalReportType = 'GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA';
export const marketplace = 'A1VC38T7YXB528';

export type CustomerReturn = {
  amazon_order_id: string;
  source_sku: string;
  returned_on: string;
  quantity: number;
  reason: string;
  disposition: string;
  amazon_status: string;
  lpn: string;
  conflict: boolean;
};

type RemovalShipment = {
  removal_order_id: string;
  requested_on: string;
  shipped_on: string;
  quantity: number;
  tracking_no: string;
  carrier: string;
};

function reportDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const instant = new Date(value + 'T00:00:00Z');
    if (Number.isFinite(instant.getTime()) && instant.toISOString().startsWith(value)) return value;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const instant = Date.parse(value);
    if (Number.isFinite(instant)) return new Date(instant + 9 * 3600000).toISOString().slice(0, 10);
  }
  throw Error('Amazon返品レポートの日付を読み取れません');
}

function* records(tsv: string): Generator<string[]> {
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < tsv.length; i++) {
    const character = tsv[i];
    if (quoted) {
      if (character !== '"') field += character;
      else if (tsv[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (character === '"' && !field) {
      quoted = true;
    } else if (character === '\t' || character === '\n') {
      row.push(character === '\n' ? field.replace(/\r$/, '') : field);
      field = '';
      if (character === '\n') { yield row; row = []; }
    } else {
      field += character;
    }
  }
  if (quoted) throw Error('Amazon返品レポートの行が途中で途切れています');
  if (row.length || field) yield [...row, field];
}

function readTable(tsv: string, required: string[]) {
  const table = records(tsv.replace(/^\uFEFF/, ''));
  const header = table.next();
  const columns = (header.done ? [] : header.value).map(value => value.trim().toLowerCase());
  if (required.some(name => columns.indexOf(name) < 0 || columns.indexOf(name) !== columns.lastIndexOf(name))) {
    throw Error('Amazon返品レポートの列を確認できません');
  }
  const indexes = new Map(columns.map((name, i) => [name, i]));
  return { table, field: (fields: string[], name: string) => (fields[indexes.get(name) ?? -1] ?? '').trim() };
}

export function parseCustomerReturns(tsv: string, importFrom: string): CustomerReturn[] {
  const { table, field: getField } = readTable(tsv, ['return-date', 'order-id', 'sku', 'quantity']);
  const rows = new Map<string, CustomerReturn>();
  for (const fields of table) {
    if (fields.every(value => !value.trim())) continue;
    const field = (name: string) => getField(fields, name);
    const returned_on = reportDate(field('return-date'));
    if (returned_on < importFrom) continue;
    const amazon_order_id = field('order-id'), source_sku = field('sku'), quantityText = field('quantity');
    if (!/^\d{3}-\d{7}-\d{7}$/.test(amazon_order_id) || !source_sku || source_sku.length > 128 ||
      !/^[1-9]\d{0,6}$/.test(quantityText)) {
      throw Error('Amazon返品レポートの注文番号・SKU・数量を確認できません');
    }
    const row: CustomerReturn = {
      amazon_order_id, source_sku, returned_on, quantity: Number(quantityText),
      reason: field('reason').slice(0, 200),
      disposition: field('detailed-disposition').slice(0, 100),
      amazon_status: field('status').slice(0, 100),
      lpn: field('license-plate-number').slice(0, 100),
      conflict: false,
    };
    const key = JSON.stringify([amazon_order_id, source_sku]);
    const previous = rows.get(key);
    if (!previous) rows.set(key, row);
    else if (JSON.stringify(previous) !== JSON.stringify(row)) previous.conflict = true;
  }
  return [...rows.values()];
}

export function parseRemovalShipments(tsv: string) {
  const { table, field: getField } = readTable(tsv, [
    'request-date', 'order-id', 'shipment-date', 'sku', 'shipped-quantity', 'carrier', 'tracking-number',
  ]);
  const groups = new Map<string, RemovalShipment[]>();
  for (const fields of table) {
    if (fields.every(value => !value.trim())) continue;
    const field = (name: string) => getField(fields, name);
    const sourceSku = field('sku'), removalOrderId = field('order-id'), quantity = field('shipped-quantity');
    const requestedOn = reportDate(field('request-date')), shippedOn = reportDate(field('shipment-date'));
    if (!sourceSku || sourceSku.length > 128 || !removalOrderId || removalOrderId.length > 128 ||
        shippedOn < requestedOn || !/^[1-9]\d{0,6}$/.test(quantity)) throw Error('FBA返送出荷明細が不正です');
    const tracking = field('tracking-number');
    const row: RemovalShipment = {
      removal_order_id: removalOrderId, requested_on: requestedOn, shipped_on: shippedOn,
      quantity: Number(quantity), carrier: field('carrier').slice(0, 100),
      tracking_no: /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9 .-]{0,127}$/.test(tracking) ? tracking : '',
    };
    const group = groups.get(sourceSku) ?? [];
    group.push(row);
    groups.set(sourceSku, group);
  }
  return [...groups].map(([source_sku, shipments]) => ({ source_sku, shipments }));
}

export async function downloadReport(
  urlText: unknown, compression: unknown, fetcher: typeof fetch = fetch,
): Promise<string> {
  if (typeof urlText !== 'string') throw Error('Amazon返品レポートの取得先がありません');
  const url = new URL(urlText);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)(amazonaws\.com|cloudfront\.net|amazon\.com)$/.test(url.hostname)) {
    throw Error('Amazon返品レポートの取得先を確認できません');
  }
  if (compression != null && compression !== 'GZIP') throw Error('Amazon返品レポートの圧縮形式に対応していません');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw Error('Amazon返品レポートをダウンロードできません');
  const stream = compression === 'GZIP' && response.headers.get('Content-Encoding') !== 'gzip'
    ? response.body.pipeThrough(new DecompressionStream('gzip')) : response.body;
  const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    const chunks: string[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 10 * 1024 * 1024) throw Error('Amazon返品レポートが処理上限を超えています');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks.join('') + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
