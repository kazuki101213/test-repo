import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: cors });
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
type Photo = { id: string; item_id: string; storage_path: string; drive_file_id: string | null; uploaded_by: string | null };
type DriveFile = { id: string; name?: string; parents?: string[] };

async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await read(from, from + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 500) return rows;
  }
}

async function moveToFolder(token: string, fileId: string, folderId: string): Promise<void> {
  const file = await drive<DriveFile>(token, `files/${encodeURIComponent(fileId)}?fields=id,parents`);
  if (file.parents?.includes(folderId)) return;
  const query = new URLSearchParams({ addParents: folderId, fields: 'id' });
  if (file.parents?.length) query.set('removeParents', file.parents.join(','));
  await drive(token, `files/${encodeURIComponent(fileId)}?${query}`, { method: 'PATCH' });
}

async function googleToken(): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new RequestError(503, 'Googleドライブの接続設定が未完了です。管理者に連絡してください。');
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!response.ok) throw new RequestError(502, 'Googleドライブの認証を更新できません。管理者に再接続を依頼してください。');
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new RequestError(502, 'Googleドライブの認証応答が不正です。');
  return body.access_token;
}

async function drive<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!response.ok) throw new RequestError(502, `Googleドライブへの保存に失敗しました（HTTP ${response.status}）。`);
  return await response.json() as T;
}

async function findFolder(token: string, parent: string, name: string): Promise<string | null> {
  const safeName = name.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const query = new URLSearchParams({
    q: `'${parent}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: '100',
  });
  const result = await drive<{ files?: DriveFile[] }>(token, `files?${query}`);
  return result.files?.[0]?.id ?? null;
}

async function createFolder(token: string, parent: string, name: string): Promise<string> {
  const folder = await drive<DriveFile>(token, 'files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  });
  if (!folder.id) throw new RequestError(502, 'GoogleドライブのフォルダIDを取得できません。');
  return folder.id;
}

async function ensureFolder(token: string, parent: string, name: string): Promise<string> {
  return await findFolder(token, parent, name) ?? await createFolder(token, parent, name);
}

async function findUploadedPhoto(token: string, folderId: string, photoId: string): Promise<string | null> {
  const query = new URLSearchParams({
    q: `'${folderId}' in parents and appProperties has { key='source_photo_id' and value='${photoId}' } and trashed = false`,
    fields: 'files(id)', pageSize: '100',
  });
  const result = await drive<{ files?: DriveFile[] }>(token, `files?${query}`);
  return result.files?.[0]?.id ?? null;
}

async function uploadToDrive(token: string, folderId: string, photo: Photo, blob: Blob): Promise<string> {
  const name = photo.storage_path.split('/').at(-1) || `${photo.id}.jpg`;
  const contentType = blob.type || 'image/jpeg';
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType, 'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: contentType, appProperties: { source_photo_id: photo.id } }),
  });
  if (!response.ok) throw new RequestError(502, `Googleドライブのアップロードを開始できません（HTTP ${response.status}）。`);
  const location = response.headers.get('Location');
  if (!location || !location.startsWith('https://www.googleapis.com/')) throw new RequestError(502, 'Googleドライブのアップロード先を確認できません。');
  const sent = await fetch(location, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
  if (!sent.ok) throw new RequestError(502, `写真のアップロードに失敗しました（HTTP ${sent.status}）。`);
  const result = await sent.json() as DriveFile;
  if (!result.id) throw new RequestError(502, '写真の保存IDを取得できません。');
  return result.id;
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POSTのみ利用できます。' });
  try {
    const authorization = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) throw new RequestError(401, 'ログインが必要です。');
    const token = authorization.replace(/^Bearer\s+/i, '');
    const { itemId, action = 'save' } = await req.json().catch(() => ({}));
    if (action !== 'list' && action !== 'save') throw new RequestError(400, '写真の操作が不正です。');
    if (typeof itemId !== 'string' || !/^[\da-f-]{36}$/i.test(itemId)) throw new RequestError(400, '商品の指定が不正です。');
    const url = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const { data: auth, error: authError } = await userClient.auth.getUser(token);
    if (authError || !auth.user) throw new RequestError(401, 'ログインが無効です。');
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const { data: profile, error: profileError } = await service.from('profiles').select('staff_id').eq('user_id', auth.user.id).maybeSingle();
    if (profileError || !profile) throw new RequestError(403, '担当者を確認できません。');
    const { data: staff, error: staffError } = await service.from('staff').select('role,is_active').eq('id', profile.staff_id).maybeSingle();
    if (staffError || !staff?.is_active) throw new RequestError(403, '担当者の権限がありません。');
    const { data: item, error: itemError } = await service.from('items').select('id,sku,lot_seq,deliverer_id').eq('id', itemId).maybeSingle();
    if (itemError || !item || (staff.role !== 'admin' && item.deliverer_id !== profile.staff_id && !(action === 'list' && staff.role === 'purchaser'))) throw new RequestError(403, 'この商品の写真を扱う権限がありません。');
    // Authorize the requested item first, then expose only its own lot's photos.
    const members = await allRows<{ id: string }>((from, to) => service.from('items')
      .select('id').eq('lot_seq', item.lot_seq).order('id').range(from, to));
    const memberIds = members.map(member => member.id);
    const photos: Photo[] = [];
    for (let start = 0; start < memberIds.length; start += 100) {
      photos.push(...await allRows<Photo>((from, to) => service.from('item_photos')
        .select('id,item_id,storage_path,drive_file_id,uploaded_by').in('item_id', memberIds.slice(start, start + 100))
        .order('created_at').order('id').range(from, to)));
    }
    if (action === 'list') {
      const urls: Array<{ id: string; url: string; canDelete: boolean }> = [];
      for (let start = 0; start < photos.length; start += 100) {
        const batch = photos.slice(start, start + 100);
        const { data: signed, error } = await service.storage.from('item-photos').createSignedUrls(batch.map(photo => photo.storage_path), 3600);
        if (error) throw error;
        for (let index = 0; index < batch.length; index++) {
          const photo = batch[index], url = signed?.[index]?.signedUrl;
          if (!photo || !url) throw new RequestError(502, '写真の読み込みに失敗しました。');
          urls.push({ id: photo.id, url, canDelete: staff.role === 'admin' || photo.uploaded_by === profile.staff_id });
        }
      }
      return json(200, { photos: urls, lotSeq: item.lot_seq });
    }
    if (!photos.length) throw new RequestError(400, '先に商品写真を追加してください。');

    const driveToken = await googleToken();
    const root = Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID') || await ensureFolder(driveToken, 'root', '納品アプリ写真');
    const { data: review, error: reviewError } = await service.from('photo_reviews').select('drive_folder_id,approved_at').eq('item_id', itemId).maybeSingle();
    if (reviewError) throw reviewError;
    const { data: existing, error: folderError } = await service.from('lot_photo_folders').select('drive_folder_id').eq('lot_seq', item.lot_seq).maybeSingle();
    if (folderError) throw folderError;
    if (!existing) {
      const candidate = review?.drive_folder_id || await ensureFolder(driveToken, root, String(item.lot_seq));
      const { error } = await service.from('lot_photo_folders').upsert({ lot_seq: item.lot_seq, drive_folder_id: candidate }, { onConflict: 'lot_seq', ignoreDuplicates: true });
      if (error) throw error;
    }
    const { data: shared, error: sharedError } = await service.from('lot_photo_folders').select('drive_folder_id').eq('lot_seq', item.lot_seq).single();
    if (sharedError) throw sharedError;
    const folderId = shared.drive_folder_id as string;
    const folder = await drive<DriveFile>(driveToken, `files/${encodeURIComponent(folderId)}?fields=id,name`);
    if (folder.name !== String(item.lot_seq)) await drive(driveToken, `files/${encodeURIComponent(folderId)}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: String(item.lot_seq) }),
    });
    let added = 0;
    for (const photo of photos as Photo[]) {
      if (photo.drive_file_id) {
        await moveToFolder(driveToken, photo.drive_file_id, folderId);
        continue;
      }
      const blobResult = await service.storage.from('item-photos').download(photo.storage_path);
      if (blobResult.error || !blobResult.data) throw new RequestError(502, '保存済みの写真を読み込めません。');
      const fileId = await findUploadedPhoto(driveToken, folderId, photo.id)
        ?? await uploadToDrive(driveToken, folderId, photo, blobResult.data);
      const { error: savedError } = await service.from('item_photos').update({ drive_file_id: fileId }).eq('id', photo.id);
      if (savedError) throw savedError;
      added++;
    }
    // Keep per-item approval and counts; only the physical folder is shared.
    for (let start = 0; start < memberIds.length; start += 100) {
      const { error } = await service.from('photo_reviews').update({ drive_folder_id: folderId }).in('item_id', memberIds.slice(start, start + 100));
      if (error) throw error;
    }
    if (added > 0 || !review) {
      const { error: taskError } = await service.from('photo_reviews').upsert({
        item_id: itemId, drive_folder_id: folderId, exported_photo_count: photos.filter(photo => photo.item_id === itemId).length,
        submitted_at: new Date().toISOString(), approved_at: null, approved_by: null, updated_at: new Date().toISOString(),
      });
      if (taskError) throw taskError;
    }
    return json(200, { folderId, added, total: photos.length });
  } catch (cause) {
    const error = cause as Error;
    return json(cause instanceof RequestError ? cause.status : 500, { error: cause instanceof RequestError ? error.message : '写真のGoogleドライブ保存に失敗しました。' });
  }
}

if (import.meta.main) Deno.serve(handler);
