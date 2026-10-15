import { initialApplication, applicationModeKey } from '../../../packages/shared/src/applicationSwitch';
document.documentElement.dataset.appHost = 'unified';
let stored: string | null = null;
try { stored = window.sessionStorage.getItem(applicationModeKey); } catch { /* Use the delivery entry when storage is unavailable. */ }
const mode = initialApplication(location.search, location.hash, stored);
// Keep imports in separate branches: Vite must preload each entry's own CSS.
async function startApplication() {
  if (mode === 'management') await import('../../admin/src/main');
  else await import('./deliveryEntry');
}
void startApplication().catch(() => {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '画面を読み込めませんでした。通信状態を確認して再読み込みしてください。';
  const button = document.createElement('button'); button.textContent = '再読み込み';
  button.onclick = () => location.reload(); root.appendChild(button);
});
