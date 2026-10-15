import { getSupabase } from './supabase';

export type InvoiceDocumentType = 'invoice' | 'receipt' | 'receipt_photo';
export interface ReceiptDetails { spent_on: string | null; description: string; amount: number | null; payee: string; memo: string; include_in_invoice: boolean }
export interface InvoiceReceipt extends Partial<ReceiptDetails> { version?: number; id: string; original_name: string; storage_path: string; document_type: InvoiceDocumentType; mime_type: string; url: string }
const bucket = 'invoice-receipts';

export function releaseReceiptImages(rows: InvoiceReceipt[]) {
  rows.forEach(row => URL.revokeObjectURL(row.url));
}

export async function loadInvoiceReceipts(staffId: string, month: string): Promise<InvoiceReceipt[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from('invoice_receipts').select('id,original_name,storage_path,document_type,mime_type,spent_on,description,amount,payee,memo,include_in_invoice,version')
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
      rows.push({
        ...record,
        document_type: record.document_type ?? 'receipt_photo',
        mime_type: record.mime_type ?? (blob.type || (record.storage_path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')),
        url: URL.createObjectURL(blob),
      } as InvoiceReceipt);
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

export async function uploadInvoiceReceipt(staffId: string, month: string, file: File, documentType: InvoiceDocumentType = 'receipt_photo', details?: ReceiptDetails): Promise<void> {
  if (file.size > 20 * 1024 * 1024) throw new Error('ファイルは1件20MB以内で選択してください。');
  const isPdf = file.type === 'application/pdf' || file.name.toLocaleLowerCase().endsWith('.pdf');
  if (!isPdf && !file.type.startsWith('image/')) throw new Error('画像またはPDFファイルを選択してください。');
  if (isPdf) {
    try { const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.load(await file.arrayBuffer()); if (!pdf.getPageCount()) throw new Error('empty'); }
    catch { throw new Error('このPDFを開けません。パスワードのないPDFで保存して選び直してください。'); }
  }
  const blob = isPdf ? file : await receiptJpeg(file);
  const extension = isPdf ? 'pdf' : 'jpg';
  const mimeType = isPdf ? 'application/pdf' : 'image/jpeg';
  const path = `${staffId}/${month}/${crypto.randomUUID()}.${extension}`;
  const sb = getSupabase();
  const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: mimeType, upsert: false, cacheControl: '0' });
  if (error) throw error;
  const { error: insertError } = await sb.from('invoice_receipts').insert({ staff_id: staffId, billing_month: month + '-01', storage_path: path, original_name: file.name.slice(0, 255) || (isPdf ? 'document.pdf' : 'receipt.jpg'), document_type: documentType, mime_type: mimeType, ...(details ?? {}) });
  if (insertError) throw insertError;
}

export async function removeInvoiceReceipt(id: string): Promise<void> {
  const { data, error } = await getSupabase().from('invoice_receipts').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('領収書を削除できません。承認済みの場合は変更できません。');
}

export function invoiceReceiptDetails(rows: InvoiceReceipt[]): InvoiceReceipt[] {
  return rows.filter(row => row.document_type !== 'invoice' && row.include_in_invoice && row.spent_on && row.description?.trim() && row.amount != null);
}
export async function updateInvoiceReceipt(row: InvoiceReceipt, details: ReceiptDetails): Promise<void> {
  const { data, error } = await getSupabase().from('invoice_receipts').update(details).eq('id', row.id).eq('version', row.version ?? 1).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('この明細は更新されています。再読み込みしてください。');
}