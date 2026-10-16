import { readResourceSnapshot } from './resourceSync';
import { usageRecordText } from './spares';
import { getSupabase } from './supabase';

export interface SpareShippingTask {
  id: string; item_id: string; accessory_item_id: string; owner_staff_id: string;
  recipient_staff_id: string; owner_code: string; owner_name: string;
  recipient_code: string; recipient_name: string; title: string;
  manufacturer: string | null; marketplace: string | null; marketplace_item_id: string | null;
  usage_note: string | null; lot_seq: number; tracking_no: string | null;
  sent_at: string | null; completed_at: string | null;
}
export async function fetchSpareShippingTasks(): Promise<SpareShippingTask[]> {
  const rows = await readResourceSnapshot<SpareShippingTask & {created_at:string}>('shipping');
  return [...rows].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))
    .map(row=>({...row,usage_note:usageRecordText(row.usage_note)}));
}
export async function sendSpareShipping(id: string, tracking: string): Promise<void> {
  const {error}=await getSupabase().rpc('send_spare_shipping',{p_task_id:id,p_tracking_no:tracking});
  if(error) throw error;
}
export async function completeSpareShipping(id: string): Promise<void> {
  const {error}=await getSupabase().rpc('complete_spare_shipping',{p_task_id:id});
  if(error) throw error;
}
