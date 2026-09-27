import { getSupabase } from './supabase';

export interface InvoiceReceipt { id: string; original_name: string; storage_path: string; url: string }
const bucket = 'invoice-receipts';

export function releaseReceiptImages(rows: InvoiceReceipt[]) {
  rows.forEach(row => URL.revokeObjectURL(row.url));
}

export async function loadInvoiceReceipts(staffId: string, month: string): Promise<InvoiceReceipt[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from('invoice_receipts').select('id,original_name,storage_path')
    .eq('staff_id', staffId).eq('billing_month', month + '-01').order('created_at').order('id');
  if (error) throw error;
  return loadReceiptImages(data ?? []);
}

export async function loadReceiptImages(files: Omit<InvoiceReceipt, 'url'>[]): Promise<InvoiceReceipt[]> {
  const sb = getSupabase();
  const rows: InvoiceReceipt[] = [];
  try {
    for (const record of files) {
      const { data: blob, error: downloadError } = await sb.storage.from(bucket).download(record.storage_path);
      if (downloadError) throw downloadError;
      rows.push({ ...record, url: URL.createObjectURL(blob) } as InvoiceReceipt);
    }
    return rows;
  } catch (e) { releaseReceiptImages(rows); throw e; }
}

async function receiptJpeg(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('領収書は画像（JPEG・PNGなど）を選択してください。');
  if (file.size > 20 * 1024 * 1024) throw new Error('画像は1枚20MB以内で選択してください。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error('この画像形式を開けません。JPEGまたはPNGで保存して選び直してください。'); }
    const scale = Math.min(1, 2600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像を読み込めませんでした。');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像を変換できませんでした。')), 'image/jpeg', .94));
  } finally { URL.revokeObjectURL(url); }
}

export async function uploadInvoiceReceipt(staffId: string, month: string, file: File): Promise<void> {
  const blob = await receiptJpeg(file);
  const path = `${staffId}/${month}/${crypto.randomUUID()}.jpg`;
  const sb = getSupabase();
  const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '0' });
  if (error) throw error;
  const { error: insertError } = await sb.from('invoice_receipts').insert({ staff_id: staffId, billing_month: month + '-01', storage_path: path, original_name: file.name.slice(0, 255) || 'receipt.jpg' });
  if (insertError) throw insertError;
}

export async function removeInvoiceReceipt(id: string): Promise<void> {
  const { data, error } = await getSupabase().from('invoice_receipts').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('領収書を削除できません。承認済みの場合は変更できません。');
}
