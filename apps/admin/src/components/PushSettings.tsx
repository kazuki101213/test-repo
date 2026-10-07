import { useEffect, useState } from 'react';
import { disableDevicePush, needsHomeScreen, pushRegistration, pushRequest, pushSupported } from '../push';

export default function PushSettings({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const homeScreen = needsHomeScreen();
  const supported = pushSupported();
  useEffect(() => {
    let active = true;
    if (supported && !homeScreen) {
      void pushRegistration().then(async registration => {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription && Notification.permission === 'granted') {
          const status = await pushRequest<{ enabled: boolean | null }>('status', { endpoint: subscription.endpoint });
          if (status.enabled === false) { await subscription.unsubscribe(); return; }
          // Rebind this browser to the signed-in account; never keep a prior owner.
          if (status.enabled === null) await pushRequest('subscribe', { subscription: subscription.toJSON(), baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href });
          if (active) setEnabled(true);
        }
      }).catch(() => { if (active) setMessage('通知設定の確認に失敗しました。再度お試しください。'); });
    }
    return () => { active = false; };
  }, [userId, supported, homeScreen]);

  async function enable() {
    setBusy(true); setMessage('');
    try {
      // iOS requires requesting permission directly from the user's button press.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMessage('通知が許可されていません。端末の設定で管理アプリの通知を許可してください。');
        return;
      }
      const [registration, config] = await Promise.all([pushRegistration(), pushRequest<{ publicKey: string }>('config')]);
      const raw = atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const applicationServerKey = Uint8Array.from(raw, char => char.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await pushRequest('subscribe', { subscription: subscription.toJSON(), baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href });
      setEnabled(true); setMessage('新しいタスクの通知を有効にしました。');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '通知を有効にできませんでした。'); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setMessage('');
    try { await disableDevicePush(); setEnabled(false); setMessage('この端末の通知を停止しました。'); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '通知を停止できませんでした。'); }
    finally { setBusy(false); }
  }

  async function testNotification() {
    setBusy(true); setMessage('');
    try {
      const subscription = await (await pushRegistration()).pushManager.getSubscription();
      if (!subscription) throw new Error('通知を有効にしてからお試しください。');
      await pushRequest('test', { endpoint: subscription.endpoint });
      setMessage('この端末にテスト通知を送信しました。');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'テスト通知を送信できませんでした。'); }
    finally { setBusy(false); }
  }

  return <section className="card no-print" aria-label="通知設定">
    <div className="row"><span>通知設定：{enabled ? '有効' : '未設定'}</span>
      {!homeScreen && supported && <button className="btn ghost" disabled={busy} onClick={() => void (enabled ? disable() : enable())}>{busy ? '設定中…' : enabled ? '通知を停止' : '通知を有効にする'}</button>}
      {enabled && <button className="btn ghost" disabled={busy} onClick={() => void testNotification()}>テスト通知</button>}
    </div>
    {homeScreen ? <p className="muted">iPhoneはSafariの共有メニューから「ホーム画面に追加」し、追加した管理アプリを開いて「通知を有効にする」を押してください（iOS 16.4以降）。</p>
      : !supported ? <p className="muted">このブラウザでは通知を利用できません。対応ブラウザまたはホーム画面から開いてください。</p>
      : <p className="muted">新しい動作不良・販売作業・写真確認・書類確認のタスクをお知らせします。通知音は端末の通知・消音設定に従います。</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
