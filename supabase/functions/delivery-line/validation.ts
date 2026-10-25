export const deliveryOrigin = 'https://test-repo-delivery.vercel.app';
export function friendUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && ['line.me', 'lin.ee'].includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export async function hashCode(code: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))), n => n.toString(16).padStart(2, '0')).join('');
}
export function linkCode(text: unknown): string | null {
  return typeof text === 'string' ? /^連携\s+([a-f0-9]{32})$/.exec(text.trim())?.[1] ?? null : null;
}
export async function validSignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, Uint8Array.from(atob(signature), c => c.charCodeAt(0)), new TextEncoder().encode(body));
  } catch { return false; }
}
export interface ShippingPayload { itemId: string; serial: string; sku: string; supplierUrl: string | null; images: string[]; withoutBarcode?: 'size_unset' }
export function shippingMessages(payload: ShippingPayload) {
  const imageCount = payload.withoutBarcode === 'size_unset' ? 2 : 3;
  if (!/^[0-9a-f-]{36}$/.test(payload.itemId) || !payload.serial || !payload.sku || payload.images.length !== imageCount) throw new Error('Incomplete shipping request');
  const supplier = payload.supplierUrl == null ? null : new URL(payload.supplierUrl);
  if (supplier && (supplier.protocol !== 'https:' || !['auctions.yahoo.co.jp','page.auctions.yahoo.co.jp','jp.mercari.com','item.mercari.com','fril.jp','item.fril.jp','www.amazon.co.jp','amazon.co.jp'].includes(supplier.hostname))) throw new Error('Invalid supplier URL');
  const images = payload.images.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid image URL');
    return { type: 'image', originalContentUrl: url.href, previewImageUrl: url.href };
  });
  return [{ type: 'text', text: `発送お願いします。\n【${payload.serial}】\n${payload.sku}\n${supplier ? `［仕入れ先］${supplier.href}\n` : ''}［納品アプリ］${deliveryOrigin}/?itemId=${payload.itemId}` }, ...images];
}
export function dispatchState(status: number): 'sent' | 'pending' | 'failed' {
  // 409 means this retry key was already accepted; never create a new key.
  return status === 200 || status === 409 ? 'sent' : status === 429 || status >= 500 ? 'pending' : 'failed';
}
