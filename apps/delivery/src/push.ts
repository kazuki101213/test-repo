import { getSupabase } from '@bussan/shared';

export async function pushRequest<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await getSupabase().functions.invoke<T>('delivery-push', { body: { action, ...body } });
  if (error) throw new Error('通知設定を保存できませんでした。通信状態を確認して再度お試しください。');
  return data as T;
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function needsHomeScreen() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !window.matchMedia('(display-mode: standalone)').matches
    && !(navigator as Navigator & { standalone?: boolean }).standalone;
}

export async function pushRegistration() {
  const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
    scope: import.meta.env.BASE_URL,
  });
  return registration.active ? registration : navigator.serviceWorker.ready;
}

export async function disableDevicePush() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  // Remove server ownership before switching accounts or signing out.
  await pushRequest('unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}
