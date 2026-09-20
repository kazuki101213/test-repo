import { getSupabase, PHOTO_BUCKET } from '@bussan/shared';
import type { DeliveryTask, ItemComment, ItemCondition, WorkStep } from '@bussan/shared';

/**
 * 納品担当アプリは app.items を直接 UPDATE しない。
 * RLS で自分の担当行しか見えないうえ、更新は RPC 経由に限定されている。
 */

export async function fetchMyTasks(): Promise<DeliveryTask[]> {
  const { data, error } = await getSupabase()
    .from('v_delivery_tasks')
    .select('*')
    .order('purchased_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DeliveryTask[];
}

export async function fetchTask(id: string): Promise<DeliveryTask | null> {
  const { data, error } = await getSupabase()
    .from('v_delivery_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as DeliveryTask) ?? null;
}

/** SKU 直打ち / スキャンから 1 件引く */
export async function findBySku(sku: string): Promise<{ id: string } | null> {
  const { data, error } = await getSupabase().rpc('find_by_sku', { p_sku: sku });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { id: string }) ?? null;
}

export async function setWorkProgress(itemId: string, step: WorkStep, done: boolean) {
  const { error } = await getSupabase().rpc('set_work_progress', {
    p_item_id: itemId,
    p_step: step,
    p_done: done,
  });
  if (error) throw error;
}

export async function updateDeliveryFields(itemId: string, fields: {
  accessories?: string;
  condition?: ItemCondition;
  tracking_no?: string;
  memo?: string;
}) {
  const { error } = await getSupabase().rpc('update_delivery_fields', {
    p_item_id: itemId,
    p_accessories: fields.accessories ?? null,
    p_condition: fields.condition ?? null,
    p_tracking_no: fields.tracking_no ?? null,
    p_memo: fields.memo ?? null,
  });
  if (error) throw error;
}

export async function fetchComments(itemId: string): Promise<ItemComment[]> {
  const { data, error } = await getSupabase()
    .from('item_comments')
    .select('*')
    .eq('item_id', itemId)
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as ItemComment[];
}

export async function postComment(itemId: string, authorId: string, body: string) {
  const { error } = await getSupabase()
    .from('item_comments')
    .insert({ item_id: itemId, author_id: authorId, body });
  if (error) throw error;
}

export async function uploadPhoto(sku: string, itemId: string, staffId: string, file: File) {
  const sb = getSupabase();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${sku}/${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (upErr) throw upErr;

  const { error } = await sb.from('item_photos').insert({
    item_id: itemId,
    storage_path: path,
    uploaded_by: staffId,
  });
  if (error) throw error;
  return path;
}

export async function fetchPhotoUrls(itemId: string): Promise<string[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('item_photos')
    .select('storage_path')
    .eq('item_id', itemId)
    .order('sort_order');
  if (error) throw error;

  const paths = (data ?? []).map((r) => (r as { storage_path: string }).storage_path);
  if (paths.length === 0) return [];

  const { data: signed, error: signErr } = await sb.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(paths, 3600);
  if (signErr) throw signErr;
  return (signed ?? [])
    .map((s) => s.signedUrl)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
}
