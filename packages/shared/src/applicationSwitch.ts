import type { Staff } from './types';
export type ApplicationMode = 'delivery' | 'management';
export const applicationModeKey = 'bussan:application-mode';
export function canOpenManagement(staff: Pick<Staff, 'role'>) { return staff.role === 'admin' || staff.role === 'purchaser'; }
export function canOpenManagementPage(staff: Pick<Staff, 'role'>, page: string) {
  return staff.role === 'admin' || (staff.role === 'purchaser' && ['inventory', 'spares'].includes(page));
}
export function initialApplication(search: string, hash: string, stored: string | null): ApplicationMode {
  const params = new URLSearchParams(search);
  if (params.get('setup') === '1' || hash.includes('type=invite') || hash.includes('type=recovery')) return 'delivery';
  if (params.has('taskKind') || hash.startsWith('#admin-')) return 'management';
  if (params.has('itemId') || (params.has('invoiceId') && params.has('invoiceMonth')) || hash === '#bid-calculator') return 'delivery';
  return stored === 'management' ? 'management' : 'delivery';
}
export function opensManagementByDefault(staff: Pick<Staff, 'code' | 'role'>, search: string, hash: string, stored: string | null) {
  return staff.code === 'AA' && staff.role === 'admin' && stored !== 'delivery' && stored !== 'management'
    && initialApplication(search, hash, 'management') === 'management';
}
export function resetApplicationChoiceForLogin() {
  try {
    // A manual switch applies to the current login, not the next sign-in.
    if (window.sessionStorage.getItem(applicationModeKey) === 'delivery') window.sessionStorage.removeItem(applicationModeKey);
  } catch { /* The default route also works without a saved application choice. */ }
}
export function switchApplication(mode: ApplicationMode) {
  if (document.documentElement.dataset.appHost === 'unified') {
    window.sessionStorage.setItem(applicationModeKey, mode);
    const url = new URL(window.location.href);
    for (const key of ['taskKind', 'itemId', 'taskId', 'invoiceStaffId', 'billingMonth', 'invoiceId', 'invoiceMonth']) url.searchParams.delete(key);
    if (url.hash === '#bid-calculator' || url.hash.startsWith('#admin-')) url.hash = '';
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    window.location.reload();
  } else window.location.assign('https://test-repo-delivery.vercel.app/');
}
