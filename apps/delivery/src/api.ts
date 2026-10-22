import { getSupabase, PHOTO_BUCKET, staffDisplayName, deliveryStaffOptions } from '@bussan/shared';
import type { DeliveryReturnRequestTask, DeliveryTask, ItemComment, ItemCondition, ItemStatus } from '@bussan/shared';

export async function completeDeliveryWork(itemId:string,date:string):Promise<void>{
 const {error}=await getSupabase().rpc('complete_delivery_work',{p_item_id:itemId,p_on:date});
 if(error)throw error;
}

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

export async function fetchMyTasks(includeAssignees = false): Promise<DeliveryTask[]> {
  const rows: DeliveryTask[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await getSupabase().from('v_delivery_tasks').select('*')
      .order('purchased_at', { ascending: false, nullsFirst: false })
      .order('lot_seq', { ascending: false }).order('id').range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data ?? []) as DeliveryTask[]);
    if ((data?.length ?? 0) < 500) return hydrateDeliveryTasks(rows, includeAssignees);
  }
}

export async function fetchReturnRequestTasks(): Promise<DeliveryReturnRequestTask[]> {
  const { data, error } = await getSupabase().from('v_delivery_return_request_tasks').select('*')
    .order('lot_seq', { ascending: true }).order('sku', { ascending: true });
  if (error) throw error;
  return (data ?? []) as DeliveryReturnRequestTask[];
}

export async function completeReturnRequestTask(taskId: string): Promise<void> {
  const { error } = await getSupabase().rpc('complete_delivery_return_request_task', { p_task_id: taskId });
  if (error) throw error;
}

async function hydrateDeliveryTasks(tasks: DeliveryTask[], includeAssignees: boolean): Promise<DeliveryTask[]> {
  const loadNames = async () => {
    const names = new Map<string, string>();
    if (!includeAssignees) return names;
    const ids = [...new Set(tasks.flatMap(task => task.deliverer_id ? [task.deliverer_id] : []))];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const { data, error } = await getSupabase().from('staff').select('id,code,name,display_name').in('id',ids.slice(offset,offset+100));
      if (error) throw error;
      for (const person of data ?? []) names.set(person.id,staffDisplayName(person));
    }
    return names;
  };
  const [rows, names] = await Promise.all([resolveWorkingReturnTracking(tasks), loadNames()]);
  return rows.map(task => includeAssignees ? { ...task, deliverer_name: names.get(task.deliverer_id ?? '') ?? null } : task);
}

function resolveWorkingReturnTracking(tasks: DeliveryTask[]): DeliveryTask[] {
  return tasks.map(task => task.marketplace === '動作品Amazon返品' ? {
    ...task,
    tracking_no: task.tracking_no || (/^X[A-Z0-9]{9}$/.test(task.title.trim()) ? task.title.trim() : null),
  } : task);
}

export interface DeliveryItemNotice {
  item_id: string;
  lot_seq: number;
  reply_at: string | null;
  photo_at: string | null;
}

export async function fetchDeliveryItemNotices(): Promise<DeliveryItemNotice[]> {
  const { data, error } = await getSupabase().rpc('list_delivery_item_notices');
  if (error) throw error;
  return (data ?? []) as DeliveryItemNotice[];
}

export async function markDeliveryItemNoticesRead(notice: DeliveryItemNotice): Promise<void> {
  const { error } = await getSupabase().rpc('mark_item_notices_read', {
    p_item_id: notice.item_id, p_reply_through: notice.reply_at, p_photo_through: notice.photo_at,
  });
  if (error) throw error;
}

export async function completeDeliveryNotice(noticeId: string, itemId: string): Promise<void> {
  const {error} = await getSupabase().rpc('complete_delivery_notice', {p_notice_id:noticeId,p_item_id:itemId});
  if (error) throw error;
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

export async function fetchTask(id: string, includeAssignees = false): Promise<DeliveryTask | null> {
  const { data, error } = await getSupabase()
    .from('v_delivery_tasks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? (await hydrateDeliveryTasks([data as DeliveryTask], includeAssignees))[0] ?? null : null;
}

/** SKU 直打ち / スキャンから 1 件引く */
export async function findBySku(sku: string): Promise<{ id: string } | null> {
  const { data, error } = await getSupabase().rpc('find_by_sku', { p_sku: sku });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { id: string }) ?? null;
}

export async function recordListingPhotoUpload(itemId: string) {
  const { error } = await getSupabase().rpc('set_delivery_listing_progress', {
    p_item_id: itemId,
    p_done: null,
  });
  if (error) throw new Error(error.message);
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
  const sb = getSupabase();
  const { data, error } = await sb.from('item_comments')
    .select('id,item_id,author_id,body,created_at,task_kind,task_completed_at,item_comment_photos(id,storage_path,sort_order)')
    .eq('item_id', itemId).order('created_at');
  if (error) throw error;
  const rows = (data ?? []) as Array<ItemComment & { item_comment_photos?: { id: string; storage_path: string; sort_order: number }[] }>;
  const attachments = rows.flatMap(row => (row.item_comment_photos ?? []).map(photo => ({ ...photo, item_comment_id: row.id })));
  const { data: signed, error: signError } = attachments.length
    ? await sb.storage.from(PHOTO_BUCKET).createSignedUrls(attachments.map(photo => photo.storage_path), 3600)
    : { data: [], error: null };
  if (signError) throw signError;
  return rows.map(row => ({
    ...row,
    photos: attachments.filter(photo => photo.item_comment_id === row.id).sort((a,b) => a.sort_order - b.sort_order)
      .flatMap(photo => {
        const url = signed?.[attachments.indexOf(photo)]?.signedUrl;
        return url ? [{ id: photo.id, url }] : [];
      }),
  }));
}
export async function postComment(itemId: string, authorId: string, body: string) {
  const { error } = await getSupabase()
    .from('item_comments')
    .insert({ item_id: itemId, author_id: authorId, body });
  if (error) throw error;
}

export async function preparePhotoForUpload(file: File): Promise<File> {
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

export async function fetchProductMaker(asin: string | null): Promise<string> {
  if (!asin) return '';
  const { data, error } = await getSupabase().from('products').select('maker').eq('asin', asin).maybeSingle();
  if (error) throw error;
  return typeof data?.maker === 'string' ? data.maker.trim() : '';
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
  first_app_sent_at?: string | null;
  sync?: { id: string; status: 'queued' | 'processing' | 'completed' | 'failed'; result_note?: string | null } | null;
  expired?: boolean;
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

export async function requestMarketplaceMessageSync(itemId: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('queue_marketplace_message_sync', { p_item_id: itemId });
  if (error) throw error;
  return data as string;
}

export async function uploadPhoto(sku: string, itemId: string, staffId: string, originalFile: File, purpose: 'product'|'packing' = 'product') {
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
      photo_kind: purpose,
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
  canDelete?: boolean;
}

export async function fetchPhotoUrls(itemId: string, purpose: 'product'|'packing' = 'product'): Promise<ItemPhoto[]> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-drive', { body: { itemId, action: 'list', purpose } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (!Array.isArray(data?.photos)) throw new Error('同じ通番号の写真を取得できませんでした。');
  return data.photos as ItemPhoto[];
}

export async function deletePhoto(photoId: string): Promise<void> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-delete', { body: { photoId } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (data?.deleted !== true) throw new Error('写真の削除結果を確認できません。');
}

export async function reflectOriginalProductPhotos(itemId: string): Promise<{ added: number; total: number; sourceSerial: string }> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-drive', { body: { itemId, action: 'reflect', purpose: 'product' } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (!data || typeof data.added !== 'number' || typeof data.total !== 'number' || typeof data.sourceSerial !== 'string') throw new Error('写真の反映結果を確認できません。');
  return data;
}

export interface PhotoReviewState {
  rejected_at?: string | null;
  rejection_reason?: string | null;
  submitted_at: string;
  approved_at: string | null;
  exported_photo_count: number;
}

export async function fetchPhotoReview(itemId: string): Promise<PhotoReviewState | null> {
  const { data, error } = await getSupabase().from('photo_reviews')
    .select('submitted_at,approved_at,exported_photo_count,rejected_at,rejection_reason').eq('item_id', itemId).maybeSingle();
  if (error) throw error;
  return data as PhotoReviewState | null;
}

export async function fetchPhotoReviewPolicy(): Promise<boolean> {
  const { data, error } = await getSupabase().rpc('photo_review_enforced');
  if (error) throw error;
  return data === true;
}

function announceReturnTaskChange(){if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('delivery-return-tasks-changed'));}

export async function addPhotosToDrive(itemId: string, purpose: 'product'|'packing' = 'product'): Promise<{ added: number; total: number }> {
  const { data, error } = await getSupabase().functions.invoke('delivery-photo-drive', { body: { itemId, purpose } });
  if (error) {
    const message = await error.context?.json?.().then((body: { error?: string }) => body.error).catch(() => null);
    throw new Error(message || error.message);
  }
  if (!data || typeof data.total !== 'number') throw new Error('Googleドライブの保存結果を確認できません。');
  announceReturnTaskChange();
  return data;
}

export async function fetchDeliveryStaff(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabase().from('staff').select('id,code,name').eq('is_active', true);
  if (error) throw error;
  return deliveryStaffOptions(data ?? []);
}

export async function fetchSpareOwners(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabase().from('staff').select('id,code,name')
    .in('role', ['admin', 'purchaser', 'deliverer']).eq('is_active', true).order('name');
  if (error) throw error;
  return deliveryStaffOptions(data ?? []);
}

export async function setInventoryWorkflow(itemId:string,status:ItemStatus):Promise<void>{
 const {error}=await getSupabase().rpc('set_inventory_workflow',{p_item_id:itemId,p_status:status});
 if(error)throw error;
}

export async function performInventoryAction(task:Pick<DeliveryTask,'id'|'status'>,action:import('@bussan/shared').InventoryAction,note?:string,requestId=crypto.randomUUID()):Promise<void>{
 const {error}=await getSupabase().rpc('perform_inventory_action',{p_item_id:task.id,p_action:action,p_expected_status:task.status,p_note:note??null,p_request_id:requestId});
 if(error)throw error;
 announceReturnTaskChange();
}
export async function performDatedInventoryAction(task:Pick<DeliveryTask,'id'|'status'>,action:'listing_complete'|'supplier_return_complete',date:string,requestId:string):Promise<void>{
 const {error}=await getSupabase().rpc('perform_dated_inventory_action',{p_item_id:task.id,p_action:action,p_expected_status:task.status,p_on:date,p_request_id:requestId});
 if(error)throw error;announceReturnTaskChange();
}
export async function completeDeliveryCompensation(itemId:string,requestId:string):Promise<void>{
 const {error}=await getSupabase().rpc('complete_delivery_compensation',{p_item_id:itemId,p_request_id:requestId});
 if(error)throw error;announceReturnTaskChange();
}
export type ReportAttachment={id:string;file:File};
export async function submitMalfunctionReport(task:Pick<DeliveryTask,'id'|'status'>,note:string,requestId:string,photos:ReportAttachment[]):Promise<void>{
 if(photos.length<1||photos.length>10)throw new Error('写真は1〜10枚で指定してください。');
 const sb=getSupabase();
 for(let index=0;index<photos.length;index++){
  const photo=photos[index]!;const file=await preparePhotoForUpload(photo.file);
  if(file.size>8*1024*1024)throw new Error('写真1枚が8MBを超えています。');
  const body=new FormData();body.set('itemId',task.id);body.set('requestId',requestId);body.set('photoId',photo.id);body.set('sortOrder',String(index));body.set('file',file);
  const {data,error}=await sb.functions.invoke('malfunction-report-photos',{body});
  if(error||data?.error)throw new Error(data?.error||error?.message||'報告写真を保存できませんでした。');
  if(data?.id!==photo.id)throw new Error('報告写真の保存結果を確認できませんでした。');
 }
 const {error}=await sb.rpc('submit_malfunction_report',{p_item_id:task.id,p_expected_status:task.status,p_note:note,p_request_id:requestId,p_photo_ids:photos.map(photo=>photo.id)});
 if(error)throw error;
 announceReturnTaskChange();
}
export interface SellerOperation {id:string;kind:string;trade_key?:string|null;status:'queued'|'running'|'succeeded'|'failed'|'uncertain';result:Record<string,unknown>;created_at:string;}
export interface SellerContext {photo_review_approved?:boolean;revision:string;assignee?:string|null;shipping_defaults?:Partial<Pick<import('@bussan/shared').SellerDraft,'shippingMethod'|'size'|'weightKg'|'dropoff'|'category'>>|null;listing:{external_id:string;url:string;trade_key:string|null}|null;operations:SellerOperation[];}
export async function fetchSellerContext(itemId:string):Promise<SellerContext>{
 const {data,error}=await getSupabase().rpc('seller_operation_context',{p_item_id:itemId});if(error)throw error;return data as SellerContext;
}
export async function requestListingResultCheck(itemId:string,listingUrl=''):Promise<string>{
 const {data,error}=await getSupabase().rpc('request_listing_result_check',{p_item_id:itemId,p_listing_url:listingUrl.trim()||null});if(error)throw error;return data as string;
}
export async function queueSellerOperation(itemId:string,kind:string,payload:Record<string,unknown>,requestId:string):Promise<string>{
 const {data,error}=await getSupabase().rpc('queue_seller_operation',{p_item_id:itemId,p_kind:kind,p_payload:payload,p_request_id:requestId});if(error)throw error;return data as string;
}
export async function fetchSupplierConversation(itemId:string):Promise<MarketplaceConversation&{account_id?:string|null}>{
 const {data,error}=await getSupabase().rpc('supplier_conversation',{p_item_id:itemId});if(error)throw error;return data;
}
export async function queueSupplierOperation(itemId:string,kind:'read'|'send',accountId:string,requestId:string,body:string|null=null):Promise<string>{
 const {data,error}=await getSupabase().rpc('queue_supplier_operation',{p_item_id:itemId,p_kind:kind,p_body:body,p_account_id:accountId,p_request_id:requestId});if(error)throw error;return data;
}
export async function fetchSupplierOperation(id:string):Promise<{status:string;note?:string|null}>{
 const {data,error}=await getSupabase().rpc('read_supplier_operation',{p_id:id});if(error)throw error;return data;
}
export async function fetchSellerOperation(id:string):Promise<{status:string;note?:string|null}>{
 const {data,error}=await getSupabase().rpc('read_seller_operation',{p_id:id});if(error)throw error;return data;
}

export async function generateListingKeywords(input: { itemId:string; target:'mercari'|'yahoo-auction'; title:string; category:string; manufacturer:string; force?:boolean }): Promise<{keywords:string;previous:string[];cached:boolean}> {
  const {data,error}=await getSupabase().functions.invoke('listing-ai-keywords',{body:input});
  if(error){
    const message=await error.context?.json?.().then((body:{error?:string})=>body.error).catch(()=>null);
    throw new Error(message||'AI生成に接続できませんでした。説明文はそのまま保存できます。');
  }
  if(typeof data?.keywords!=='string'||!data.keywords.trim())throw new Error('生成結果を確認できません。');
  return {keywords:data.keywords,previous:Array.isArray(data.previous)?data.previous.filter((v:unknown)=>typeof v==='string'):[],cached:data.cached===true};
}
