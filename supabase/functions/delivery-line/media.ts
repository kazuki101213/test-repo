import type { ShippingPayload } from './validation.ts';
export async function prepareShippingMedia({ admin, media, deliveryId, QRCode, fetcher = fetch }: {
  admin: any; media: { itemId: string; serial: string; sku: string; supplierUrl: string | null; photoPaths: string[]; codeOperationId: string | null; withoutBarcode?: string; automatic?: boolean };
  deliveryId: string; QRCode: { toDataURL(text: string, options: unknown): Promise<string> }; fetcher?: typeof fetch;
}): Promise<ShippingPayload> {
  if (!Array.isArray(media.photoPaths) || (media.automatic === true ? media.photoPaths.length > 2 : media.photoPaths.length !== 2) || media.photoPaths.some(path => typeof path !== 'string' || !/\.(?:jpe?g|png)$/i.test(path))) throw new Error('通知写真はJPEGまたはPNGを指定してください');
  let codeUrl: string | undefined;
  if (media.codeOperationId) {
  const { data: operation, error } = await admin.from('seller_operations').select('result').eq('id', media.codeOperationId).eq('item_id', media.itemId).eq('status', 'succeeded').maybeSingle();
  if (error) throw error;
  const code = operation?.result?.qr_code;
  if (typeof code !== 'string' || !code || code.length > 6 * 1024 * 1024) throw new Error('発送コードを確認できません');
  const dataUrl = code.startsWith('data:image/png;base64,') ? code : !code.startsWith('data:') && code.length <= 4096 ? await QRCode.toDataURL(code, { width: 768, margin: 4, errorCorrectionLevel: 'M' }) : null;
  if (!dataUrl?.startsWith('data:image/png;base64,')) throw new Error('発送コードの画像形式を確認できません');
  const bytes = Uint8Array.from(atob(dataUrl.slice('data:image/png;base64,'.length)), char => char.charCodeAt(0));
  if (bytes.length > 4 * 1024 * 1024 || ![137,80,78,71,13,10,26,10].every((n,index) => bytes[index] === n)) throw new Error('発送コード画像が不正です');
  const codePath = `${deliveryId}.png`;
  // Product photos stay in their existing bucket. Only the code is generated.
  const upload = await admin.storage.from('line-shipping-codes').upload(codePath, bytes, { contentType: 'image/png', cacheControl: '3600', upsert: true });
  if (upload.error) throw upload.error;
  const qr = await admin.storage.from('line-shipping-codes').createSignedUrl(codePath, 7 * 86400);
  if (qr.error || !qr.data?.signedUrl) throw new Error('通知画像のURLを準備できません');
  codeUrl = qr.data.signedUrl;
  } else if (media.withoutBarcode !== 'size_unset' && media.automatic !== true) {
    throw new Error('発送コードを確認できません');
  }
  const photos = media.photoPaths.length ? await admin.storage.from('item-photos').createSignedUrls(media.photoPaths, 7 * 86400) : {data:[],error:null};
  if (photos.error) throw photos.error;
  const images = [...(photos.data || []).map((photo: { signedUrl?: string }) => photo.signedUrl), ...(codeUrl ? [codeUrl] : [])];
  if (images.length !== media.photoPaths.length + (codeUrl ? 1 : 0) || images.some(url => typeof url !== 'string')) throw new Error('通知画像が不足しています');
  // HEAD validates images without downloading full photos through this function.
  await Promise.all(images.map(async url => {
    const response = await fetcher(url!, { method: 'HEAD', signal: AbortSignal.timeout(8000), redirect: 'error' });
    const type = response.headers.get('content-type')?.split(';')[0],size = Number(response.headers.get('content-length'));
    if (!response.ok || !['image/jpeg','image/png'].includes(type || '') || !Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) throw new Error('通知画像を取得できません');
  }));
  return { itemId: media.itemId, serial: media.serial, sku: media.sku, supplierUrl: media.supplierUrl, images: images as string[], ...(media.automatic === true ? {automatic:true} : !codeUrl ? {withoutBarcode: 'size_unset' as const} : {}) };
}
