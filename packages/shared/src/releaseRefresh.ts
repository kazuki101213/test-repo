// 開いたままの画面を、新しい版が出たら目立たないときだけ読み直す。
// 条件：新しい版がある／1時間操作がない／文字を入力した欄が残っていない。
// 使っている最中や入力途中には読み直さないので、使い勝手は変わらない。
export const RELEASE_CHECK_MS = 10 * 60_000;
export const RELEASE_IDLE_MS = 60 * 60_000;

/** 読み込み済みの画面の本体スクリプト（Viteのビルド結果）。開発中は null。 */
export function entryScriptFromDocument(doc: Pick<Document, 'querySelectorAll'>): string | null {
  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
    const path = scriptPath(script.getAttribute('src') ?? '');
    if (path) return path;
  }
  return null;
}

/** 配信中の index.html に書かれた本体スクリプト。 */
export function entryScriptFromHtml(html: string): string | null {
  for (const match of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/gi)) {
    const src = /\bsrc=["']([^"']+)["']/i.exec(match[0])?.[1];
    const path = src ? scriptPath(src) : null;
    if (path) return path;
  }
  return null;
}

function scriptPath(src: string): string | null {
  try {
    const path = new URL(src, 'https://release.invalid/').pathname;
    return /\/assets\/[^/]+\.js$/.test(path) ? path : null;
  } catch { return null; }
}

/** 利用者が文字を入力した欄が、まだ画面に残って中身があるか。 */
export function hasTypedInput(typed: Iterable<Element>): boolean {
  for (const element of typed) {
    if (!element.isConnected) continue;
    if ('value' in element && String((element as HTMLInputElement).value ?? '').trim()) return true;
    if ((element as HTMLElement).isContentEditable && element.textContent?.trim()) return true;
  }
  return false;
}

export function shouldReloadForRelease(state: {current: string | null; latest: string | null; now: number; lastActivity: number; typedInput: boolean}): boolean {
  return !!state.current && !!state.latest && state.latest !== state.current
    && state.now - state.lastActivity >= RELEASE_IDLE_MS && !state.typedInput;
}

/** アプリ起動時に1回呼ぶ。 */
export function startReleaseRefresh(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const current = entryScriptFromDocument(document);
  if (!current) return () => {};
  let latest: string | null = null, lastActivity = Date.now(), checking = false;
  const typed = new Set<Element>();
  const active = () => { lastActivity = Date.now(); };
  const onInput = (event: Event) => { active(); if (event.target instanceof Element) typed.add(event.target); };
  const activityEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
  activityEvents.forEach(name => window.addEventListener(name, active, {passive: true, capture: true}));
  document.addEventListener('input', onInput, true);
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(new URL('/', location.origin).href, {cache: 'no-store', credentials: 'same-origin'});
      if (response.ok) latest = entryScriptFromHtml(await response.text()) ?? latest;
    } catch { /* 通信できないときは次の確認まで待つ */ } finally { checking = false; }
    for (const element of typed) if (!element.isConnected) typed.delete(element);
    if (shouldReloadForRelease({current, latest, now: Date.now(), lastActivity, typedInput: hasTypedInput(typed)})) location.reload();
  };
  const timer = window.setInterval(() => void check(), RELEASE_CHECK_MS);
  return () => {
    window.clearInterval(timer);
    activityEvents.forEach(name => window.removeEventListener(name, active, {capture: true}));
    document.removeEventListener('input', onInput, true);
  };
}
