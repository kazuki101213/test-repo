export type AdminTaskKind = 'malfunction' | 'action' | 'photo_review' | 'invoice' | 'receipts';
export function adminTaskNotice(search: string = location.search) {
  const query = new URLSearchParams(search);
  const kind = query.get('taskKind') as AdminTaskKind | null;
  if (!kind || !['malfunction','action','photo_review','invoice','receipts'].includes(kind)) return null;
  const uuid = (key: string) => { const value = query.get(key); return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null; };
  const month = query.get('billingMonth');
  return { kind, itemId: uuid('itemId'), taskId: uuid('taskId'), invoiceStaffId: uuid('invoiceStaffId'),
    billingMonth: month && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(month) ? month : null };
}
