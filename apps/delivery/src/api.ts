import { getSupabase, PHOTO_BUCKET } from '@bussan/shared';
import type { DeliveryTask, ItemComment, ItemCondition, WorkStep } from '@bussan/shared';

export async function fetchAmazonFeed(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await getSupabase().from('v_amazon_listing_feed').select('*')
      .order('item_id').range(from, from + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) return rows;
  }
}

/**
 * 納品担当アプリは app.items を直接 UPDATE しない。
 * RLS で自分の担当行しか見えないうえ、更新は RPC 経由に限定されている。
 */

export async function fetchMyTasks(): Promise<DeliveryTask[]> {
  const rows: DeliveryTask[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getSupabase().from('v_delivery_tasks').select('*')
      .order('purchased_at', { ascending: false, nullsFirst: false })
      .order('lot_seq', { ascending: false }).order('id').range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []) as DeliveryTask[]);
    if ((data?.length ?? 0) < 500) return rows;
  }
}

export async function saveDeliveryDescription(itemId: string, input: {
  condition: ItemCondition | null; accessories: string; description: string; template: string | null; year: number | null;
}) {
  const { error } = await getSupabase().rpc('save_delivery_description', {
    p_item_id: itemId, p_condition: input.condition, p_accessories: input.accessories,
    p_description: input.description, p_template: input.template, p_manufacture_year: input.year,
  });
  if (error) throw error;
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

export async function setDeliveryProgress(itemId: string, step: 'inspection_cleaning' | 'listing' | 'packed' | 'shipped', done: boolean, date?: string) {
  const { error } = await getSupabase().rpc('set_delivery_progress', {
    p_item_id: itemId, p_step: step, p_done: done, p_on: date ?? null,
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

/** One signed uploaded photo per visible inventory card; Amazon art is used as fallback. */
export async function fetchTaskThumbnails(tasks: DeliveryTask[]): Promise<Record<string, string>> {
  const sb = getSupabase();
  const first = new Map<string, string>();
  const ids = tasks.filter(task => task.photo_count > 0).map(task => task.id);
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await sb.from('item_photos').select('item_id,storage_path')
      .in('item_id', ids.slice(start, start + 100)).order('sort_order').order('created_at');
    if (error) throw error;
    for (const row of data ?? []) if (!first.has(row.item_id)) first.set(row.item_id, row.storage_path);
  }
  const entries = [...first.entries()];
  const thumbnails: Record<string, string> = {};
  for (let start = 0; start < entries.length; start += 100) {
    const chunk = entries.slice(start, start + 100);
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(chunk.map(([, path]) => path), 3600);
    if (error) throw error;
    chunk.forEach(([id], index) => { if (data?.[index]?.signedUrl) thumbnails[id] = data[index].signedUrl; });
  }
  return thumbnails;
}
