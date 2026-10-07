import { getSupabase } from './supabase';
import { DELIVERY_STAFF_CODES, staffDisplayName } from './staffNames';

const spareCollator = new Intl.Collator('ja', { numeric: true });
export function sortSpareAccessories(rows: SpareAccessory[], owners: {id: string; code?: string; name: string}[]): SpareAccessory[] {
  const codes = new Map(owners.map(owner => [owner.id, owner.code || '']));
  const ownerKey = (row: SpareAccessory) => {
    const label = staffDisplayName(row.owner_name?.replace(/^\([^)]*\)/, '')).trim();
    const code = (row.owner_staff_id && codes.get(row.owner_staff_id)) || label.split(' ')[0];
    const rank = DELIVERY_STAFF_CODES.findIndex(value => value === code);
    return {rank: rank < 0 ? (label ? DELIVERY_STAFF_CODES.length : DELIVERY_STAFF_CODES.length + 1) : rank, label};
  };
  return [...rows].sort((a, b) => {
    const x = ownerKey(a), y = ownerKey(b);
    return x.rank - y.rank
      || (x.rank >= DELIVERY_STAFF_CODES.length ? spareCollator.compare(x.label, y.label) : 0)
      || Number(!a.manufacturer?.trim()) - Number(!b.manufacturer?.trim())
      || spareCollator.compare(a.manufacturer?.trim() || '', b.manufacturer?.trim() || '');
  });
}

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
    let query = getSupabase().from('spare_accessories').select('*').is('used_for_item_id', null)
      .order('source_sheet_row', { ascending: false }).order('id').range(from, from + 499);
    if (ownerStaffId) query = query.eq('owner_staff_id', ownerStaffId);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data ?? []) as SpareAccessory[]);
    if ((data?.length ?? 0) < 500) {
      const ids = [...new Set(rows.flatMap(row => row.owner_staff_id ? [row.owner_staff_id] : []))];
      const owners: {id: string; code: string; name: string}[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await getSupabase().from('staff').select('id,code,name').in('id', ids.slice(offset, offset + 100));
        if (result.error) throw result.error;
        owners.push(...(result.data ?? []));
      }
      return sortSpareAccessories(rows, owners);
    }
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
