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

export async function reportItemMalfunction(itemId: string, comment: string) {
  const { error } = await getSupabase().rpc('report_item_malfunction', {
    p_item_id: itemId, p_comment: comment,
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

async function preparePhotoForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('この写真形式を読み込めません。端末のカメラ設定をJPEGにするか、写真をJPEG形式で保存してから追加してください。');
  }
  try {
    const maxEdge = 1920;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('写真を変換できません。ページを再読み込みしてもう一度お試しください。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const toJpeg = (quality: number) => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('写真をJPEG形式へ変換できませんでした。')), 'image/jpeg', quality);
    });
    let blob = await toJpeg(0.84);
    if (blob.size > 5 * 1024 * 1024) blob = await toJpeg(0.68);
    if (blob.size > 8 * 1024 * 1024) throw new Error('写真の容量を小さくできませんでした。端末で写真を小さくしてから追加してください。');
    const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'photo';
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

export interface MarketplaceMessage {
  id: string;
  author: string | null;
  author_role: 'self' | 'other' | 'unknown';
  body: string;
  sent_at: string | null;
}
export interface MarketplaceMessageRequest {
  id: string;
  body: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
  requested_at: string;
  sent_at: string | null;
  result_note: string | null;
}
export interface MarketplaceConversation {
  messages: MarketplaceMessage[];
  outbox: MarketplaceMessageRequest[];
}

export async function fetchMarketplaceConversation(itemId: string): Promise<MarketplaceConversation> {
  const { data, error } = await getSupabase().rpc('read_marketplace_messages', { p_item_id: itemId });
  if (error) throw error;
  return (data ?? { messages: [], outbox: [] }) as MarketplaceConversation;
}

export async function queueMarketplaceMessage(itemId: string, body: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('queue_marketplace_message', { p_item_id: itemId, p_body: body });
  if (error) throw error;
  return data as string;
}

export async function uploadPhoto(sku: string, itemId: string, staffId: string, originalFile: File) {
  const sb = getSupabase();
  const file = await preparePhotoForUpload(originalFile);
  const path = `${sku}/${crypto.randomUUID()}.jpg`;

  const { error: upErr } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (upErr) throw upErr;

  try {
    const { error } = await sb.from('item_photos').insert({
      item_id: itemId,
      storage_path: path,
      uploaded_by: staffId,
    });
    if (error) throw error;
  } catch (error) {
    await sb.storage.from(PHOTO_BUCKET).remove([path]).catch(() => undefined);
    throw error;
  }
  return path;
}
export interface ItemPhoto {
  id: string;
  url: string;
}

export async function fetchPhotoUrls(itemId: string): Promise<ItemPhoto[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('item_photos')
    .select('id,storage_path')
    .eq('item_id', itemId)
    .order('sort_order');
  if (error) throw error;

  const rows = (data ?? []) as { id: string; storage_path: string }[];
  if (rows.length === 0) return [];

  const { data: signed, error: signErr } = await sb.storage
    .from(PHOTO_BUCKET)
    .createSignedUrls(rows.map(row => row.storage_path), 3600);
  if (signErr) throw signErr;
  return rows.flatMap((row, index) => {
    const url = signed?.[index]?.signedUrl;
    return typeof url === 'string' && url.length > 0 ? [{ id: row.id, url }] : [];
  });
}

export async function deletePhoto(photoId: string): Promise<void> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-delete', { body: { photoId } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (data?.deleted !== true) throw new Error('写真の削除結果を確認できません。');
}

export interface PhotoReviewState {
  submitted_at: string;
  approved_at: string | null;
  exported_photo_count: number;
}

export async function fetchPhotoReview(itemId: string): Promise<PhotoReviewState | null> {
  const { data, error } = await getSupabase().from('photo_reviews')
    .select('submitted_at,approved_at,exported_photo_count').eq('item_id', itemId).maybeSingle();
  if (error) throw error;
  return data as PhotoReviewState | null;
}

export async function fetchPhotoReviewPolicy(): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('photo_review_enforced');
  if (error) throw error;
  return data === true;
}

export async function addPhotosToDrive(itemId: string): Promise<{ added: number; total: number }> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-drive', { body: { itemId } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (!data || typeof data.total !== 'number') throw new Error('Googleドライブの保存結果を確認できません。');
  return data;
}

export async function fetchDeliveryStaff(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabase().from('staff').select('id,name').eq('role', 'deliverer').eq('is_active', true).order('name');
  if (error) throw error;
  return data ?? [];
}

export async function fetchSpareOwners(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabase().from('staff').select('id,name')
    .in('role', ['admin', 'purchaser', 'deliverer']).eq('is_active', true).order('name');
  if (error) throw error;
  return data ?? [];
}
