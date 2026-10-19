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
type Photo={id:string;storage_path:string};
type DriveFile={id:string;name?:string;parents?:string[]};
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


export async function handler(req:Request):Promise<Response>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST')return json(405,{error:'POSTのみ利用できます。'});
 try{
  const authorization=req.headers.get('authorization')??'';
  if(!/^Bearer\s+\S+$/i.test(authorization))throw new RequestError(401,'ログインが必要です。');
  const url=Deno.env.get('SUPABASE_URL')!;
  const user=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:auth,error:authError}=await user.auth.getUser(authorization.replace(/^Bearer\s+/i,''));
  if(authError||!auth.user)throw new RequestError(401,'ログインが無効です。');
  const form=await req.formData();
  const itemId=form.get('itemId'),requestId=form.get('requestId'),photoId=form.get('photoId'),orderText=form.get('sortOrder'),file=form.get('file');
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(![itemId,requestId,photoId].every(value=>typeof value==='string'&&uuid.test(value))||typeof orderText!=='string'||!/^[0-9]$/.test(orderText))throw new RequestError(400,'写真の指定が不正です。');
  if(!(file instanceof File)||file.type!=='image/jpeg'||file.size<3||file.size>8*1024*1024)throw new RequestError(400,'写真は8MB以下のJPEGで送信してください。');
  const magic=new Uint8Array(await file.slice(0,3).arrayBuffer());
  if(magic[0]!==255||magic[1]!==216||magic[2]!==255)throw new RequestError(400,'JPEG画像を確認できません。');
  const service=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false},db:{schema:'app'}});
  const {data:profile,error:profileError}=await service.from('profiles').select('staff_id').eq('user_id',auth.user.id).maybeSingle();
  if(profileError||!profile)throw new RequestError(403,'担当者を確認できません。');
  const {data:staff,error:staffError}=await service.from('staff').select('role,is_active').eq('id',profile.staff_id).maybeSingle();
  if(staffError||!staff?.is_active)throw new RequestError(403,'担当者の権限がありません。');
  const {data:item,error:itemError}=await service.from('items').select('id,sku,lot_seq,status,deliverer_id,purchaser_id,is_accessory').eq('id',itemId).maybeSingle();
  if(itemError||!item||!(staff.role==='admin'||item.deliverer_id===profile.staff_id||(staff.role==='purchaser'&&item.purchaser_id===profile.staff_id)))throw new RequestError(403,'この商品の写真を扱う権限がありません。');
  const {data:existing,error:existingError}=await service.from('malfunction_report_photos').select('id,item_id,request_id,uploaded_by,sort_order').eq('id',photoId).maybeSingle();
  if(existingError)throw new RequestError(502,'写真の保存状況を確認できません。');
  if(existing){
   if(existing.item_id!==itemId||existing.request_id!==requestId||existing.uploaded_by!==profile.staff_id||existing.sort_order!==Number(orderText))throw new RequestError(409,'写真の保存IDが一致しません。');
   return json(200,{id:existing.id});
  }
  if(item.status!=='検品中'||(item.is_accessory&&!/^[0-9]+[a-z]*c(?:[-_]|$)/i.test(item.sku)))throw new RequestError(409,'検品中の本体または別売り付属品で報告してください。');
  const driveToken=await googleToken();
  const root=Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID')||await ensureFolder(driveToken,'root','納品アプリ写真');
  const lotFolder=await ensureFolder(driveToken,root,String(item.lot_seq));
  const reportsFolder=await ensureFolder(driveToken,lotFolder,'動作不良報告');
  const folder=await ensureFolder(driveToken,reportsFolder,String(requestId));
  const driveId=await findUploadedPhoto(driveToken,folder,String(photoId))??await uploadToDrive(driveToken,folder,{id:String(photoId),storage_path:String(Number(orderText)+1).padStart(2,'0')+'.jpg'},file);
  const {error:saveError}=await service.from('malfunction_report_photos').insert({id:photoId,item_id:itemId,request_id:requestId,uploaded_by:profile.staff_id,drive_file_id:driveId,sort_order:Number(orderText)});
  if(saveError)throw new RequestError(502,'写真の保存情報を登録できませんでした。同じ写真で再度お試しください。');
  return json(200,{id:photoId});
 }catch(cause){return json(cause instanceof RequestError?cause.status:500,{error:cause instanceof RequestError?cause.message:'報告写真を保存できませんでした。'});}
}
if(import.meta.main)Deno.serve(handler);
