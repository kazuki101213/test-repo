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
  const rows: SpareShippingTask[] = [];
  for (let start=0;;start+=500) {
    const {data,error}=await getSupabase().from('v_spare_shipping_tasks').select('*')
      .is('completed_at',null).order('created_at').order('id').range(start,start+499);
    if(error) throw error;
    rows.push(...(data ?? []) as SpareShippingTask[]);
    if((data?.length ?? 0)<500) return rows;
  }
}
export async function sendSpareShipping(id: string, tracking: string): Promise<void> {
  const {error}=await getSupabase().rpc('send_spare_shipping',{p_task_id:id,p_tracking_no:tracking});
  if(error) throw error;
}
export async function completeSpareShipping(id: string): Promise<void> {
  const {error}=await getSupabase().rpc('complete_spare_shipping',{p_task_id:id});
  if(error) throw error;
}
