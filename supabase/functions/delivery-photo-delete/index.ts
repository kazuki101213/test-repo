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

async function googleToken(): Promise<string> {
  const clientId = Deno.env.get('GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) throw new RequestError(503, 'Googleドライブの接続設定が未完了です。');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  if (!response.ok) throw new RequestError(502, 'Googleドライブの認証を更新できません。');
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new RequestError(502, 'Googleドライブの認証応答が不正です。');
  return body.access_token;
}

async function deleteDriveFile(token: string, fileId: string) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) throw new RequestError(502, 'Googleドライブ上の写真を削除できません。');
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'POSTのみ利用できます。' });
  try {
    const authorization = req.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) throw new RequestError(401, 'ログインが必要です。');
    const token = authorization.replace(/^Bearer\s+/i, '');
    const { photoId } = await req.json().catch(() => ({}));
    if (typeof photoId !== 'string' || !/^[\da-f-]{36}$/i.test(photoId)) throw new RequestError(400, '写真の指定が不正です。');

    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const user = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false }, db: { schema: 'app' },
    });
    const { data: auth, error: authError } = await user.auth.getUser(token);
    if (authError || !auth.user) throw new RequestError(401, 'ログインが無効です。');
    const { data: profile, error: profileError } = await service.from('profiles').select('staff_id').eq('user_id', auth.user.id).maybeSingle();
    if (profileError || !profile) throw new RequestError(403, '担当者を確認できません。');
    const { data: staff, error: staffError } = await service.from('staff').select('role,is_active').eq('id', profile.staff_id).maybeSingle();
    if (staffError || !staff?.is_active) throw new RequestError(403, '担当者の権限がありません。');
    const { data: photo, error: photoError } = await service.from('item_photos')
      .select('id,item_id,storage_path,drive_file_id,uploaded_by').eq('id', photoId).maybeSingle();
    if (photoError || !photo) throw new RequestError(404, '写真が見つかりません。');
    if (staff.role !== 'admin' && photo.uploaded_by !== profile.staff_id) throw new RequestError(403, 'この写真を削除する権限がありません。');

    let driveDeleted = false;
    if (photo.drive_file_id) {
      await deleteDriveFile(await googleToken(), photo.drive_file_id);
      driveDeleted = true;
    }
    const { error: storageError } = await service.storage.from('item-photos').remove([photo.storage_path]);
    if (storageError) {
      if (driveDeleted) await service.from('item_photos').update({ drive_file_id: null }).eq('id', photoId);
      throw new RequestError(502, '写真ファイルを削除できませんでした。');
    }
    const { data: deleted, error: deleteError } = await user.from('item_photos').delete().eq('id', photoId).select('id');
    if (deleteError) throw deleteError;
    if (!deleted?.length) throw new RequestError(403, 'この写真を削除する権限がありません。');
    return json(200, { deleted: true });
  } catch (cause) {
    const error = cause as Error;
    return json(cause instanceof RequestError ? cause.status : 500, {
      error: cause instanceof RequestError ? error.message : '写真を削除できませんでした。',
    });
  }
}

if (import.meta.main) Deno.serve(handler);
