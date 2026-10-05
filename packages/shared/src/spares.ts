import { getSupabase } from './supabase';

export interface SpareAccessory {
  id: string;
  source_sheet_row: number | null;
  source_sku: string | null;
  owner_staff_id: string | null;
  owner_name: string | null;
  purchased_at: string | null;
  title: string;
  manufacturer: string | null;
  model_no: string | null;
  asin: string | null;
  cost_amount: number;
  marketplace: string | null;
  marketplace_item_id: string | null;
  tracking_no: string | null;
  usage_note: string | null;
  linked_item_id: string | null;
  used_for_item_id: string | null;
}

export async function fetchSpareAccessories(ownerStaffId?: string): Promise<SpareAccessory[]> {
  const rows: SpareAccessory[] = [];
  for (let from = 0; ; from += 500) {
    let query = getSupabase().from('spare_accessories').select('*')
      .order('source_sheet_row', { ascending: false }).range(from, from + 499);
    if (ownerStaffId) query = query.eq('owner_staff_id', ownerStaffId);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data ?? []) as SpareAccessory[]);
    if ((data?.length ?? 0) < 500) return rows;
  }
}

export async function deleteSpareAccessory(id: string): Promise<void> {
  const { data, error } = await getSupabase().from('spare_accessories').delete()
    .eq('id', id).is('used_for_item_id', null)
    .select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('この予備は削除できません。すでに使用・割当済みか、削除権限がありません。');
}

export function spareState(spare: SpareAccessory): string {
  if (spare.used_for_item_id) return '使用済';
  if (spare.usage_note) return '使用記録あり';
  return '予備';
}
