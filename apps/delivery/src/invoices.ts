import { getSupabase } from '@bussan/shared';

export interface InvoiceDetails {
  issuer_name: string; postal: string; address: string; phone: string; email: string;
  recipient: string; bank: string; bank_code: string; branch: string; branch_code: string;
  account_type: string; account_number: string; holder: string; holder_kana: string; source_month: string;
}
export interface InvoiceProfile { staff_id: string; details: InvoiceDetails; unit_price: number; enabled: boolean }
export interface InvoiceLine {
  date: string | null; description: string; quantity: number; unit_price: number; amount?: number;
  lot_seq?: number; item_id?: string; title?: string; packed_on?: string;
}
export interface InvoiceSnapshot {
  profile: InvoiceDetails; lines: InvoiceLine[]; extras?: InvoiceLine[];
  subtotal: number; tax_percent: number; tax?: number;
}
export interface Invoice {
  id: string; staff_id: string; billing_month: string; issued_on: string; extras: InvoiceLine[];
  note: string; snapshot: InvoiceSnapshot; total: number; version: number; updated_at: string;
}

export async function invoiceProfiles(): Promise<InvoiceProfile[]> {
  const { data, error } = await getSupabase().from('delivery_invoice_profiles').select('staff_id,details,unit_price,enabled').order('staff_id');
  if (error) throw error;
  return data as InvoiceProfile[];
}
export async function findInvoice(staff: string, month: string): Promise<Invoice | null> {
  const { data, error } = await getSupabase().from('delivery_invoices').select('*').eq('staff_id', staff).eq('billing_month', month + '-01').maybeSingle();
  if (error) throw error;
  return data as Invoice | null;
}
export async function prepareInvoice(staff: string, month: string): Promise<InvoiceSnapshot> {
  const { data, error } = await getSupabase().rpc('prepare_delivery_invoice', { p_staff: staff, p_month: month + '-01' });
  if (error) throw error;
  return data as InvoiceSnapshot;
}
export async function saveInvoice(staff: string, month: string, issued: string, extras: InvoiceLine[], note: string, previous: Invoice | null): Promise<Invoice> {
  const fields = { issued_on: issued, extras, note };
  const query = previous
    ? getSupabase().from('delivery_invoices').update(fields).eq('id', previous.id).eq('version', previous.version)
    : getSupabase().from('delivery_invoices').insert({ ...fields, staff_id: staff, billing_month: month + '-01' });
  const { data, error } = await query.select('*').maybeSingle();
  if (error) {
    if (error.code === '23505') throw new Error('この月の請求書はすでに保存されています。月を選び直して開いてください。');
    throw error;
  }
  if (!data) throw new Error('別の画面で更新されています。月を選び直して最新の請求書を開いてください。');
  return data as Invoice;
}
export async function saveInvoiceProfile(profile: InvoiceProfile): Promise<void> {
  const { data, error } = await getSupabase().from('delivery_invoice_profiles')
    .update({ details: profile.details, unit_price: profile.unit_price }).eq('staff_id', profile.staff_id).select('staff_id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('設定を保存する権限がありません。');
}
export const yen = (amount: number) => '¥' + amount.toLocaleString('ja-JP');
export const japanToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
