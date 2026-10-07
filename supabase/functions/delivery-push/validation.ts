export function validSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!value || typeof value !== 'object') return false;
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof sub.endpoint !== 'string' || sub.endpoint.length > 4096 || !sub.keys) return false;
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (!['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(url.hostname)) return false;
    if (typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(sub.keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(sub.keys.auth)) return false;
    const decode = (text: string) => atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const key = decode(sub.keys.p256dh);
    return key.length === 65 && key.charCodeAt(0) === 4 && decode(sub.keys.auth).length === 16;
  } catch { return false; }
}

export function notificationBody(kind: string, lot: number): string {
  if (kind === 'reply') return `【${lot}】メッセージが届きました`;
  if (kind === 'photo') return `【${lot}】写真が承認されました。`;
  return `【${lot}】新しい担当商品が追加されました。`;
}
