// 同じ読み込みが短時間に何十回も続いたときだけ間を空け、DBを1つの画面が占有しないようにする。
// 普段の操作（一覧の更新は5秒以上、監視は15秒ごと）では上限に届かないので、使い勝手は変わらない。
export const READ_GUARD_WINDOW_MS = 60_000;
export const READ_GUARD_LIMIT = 30;
export const READ_GUARD_PAUSE_MS = 10_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const recent = new Map<string, {times: number[]; trippedUntil: number}>();
const warned = new Set<string>();

/** 抑制の対象になる読み込みのキー。書き込み・認証・ストレージは対象外で null を返す。 */
export function guardedReadKey(input: string | URL | Request, init?: RequestInit): string | null {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  if (!path.startsWith('/rest/v1/')) return null;
  if (method === 'GET' || method === 'HEAD') return `${method} ${url}`;
  if (method === 'POST' && /^\/rest\/v1\/rpc\/(read_|list_)/.test(path)) {
    return `${method} ${url} ${typeof init?.body === 'string' ? init.body : ''}`;
  }
  return null;
}

/**
 * 直近1分の同じ読み込みが上限に達したら、その読み込みは1分間止むまで毎回間を空ける。
 * 待つ時間（ミリ秒）を返し、呼ぶたびに1回として記録する。
 */
export function readGuardDelay(key: string, now: number): number {
  if (recent.size > 500) {
    for (const [k, state] of recent) {
      const last = state.times[state.times.length - 1] ?? 0;
      if (now - last >= READ_GUARD_WINDOW_MS && now >= state.trippedUntil) recent.delete(k);
    }
  }
  const state = recent.get(key) ?? {times: [], trippedUntil: 0};
  state.times = state.times.filter(time => now - time < READ_GUARD_WINDOW_MS);
  const tripped = now < state.trippedUntil || state.times.length >= READ_GUARD_LIMIT;
  const wait = tripped ? READ_GUARD_PAUSE_MS : 0;
  const sentAt = now + wait;
  state.times.push(sentAt);
  if (tripped) state.trippedUntil = sentAt + READ_GUARD_WINDOW_MS;
  recent.set(key, state);
  return wait;
}

export function resetReadGuard() { recent.clear(); warned.clear(); }

function pause(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Supabase クライアントに渡す fetch。連発した読み込みだけを遅らせる。 */
export function createGuardedFetch(base: FetchLike = (input, init) => fetch(input, init), now: () => number = () => Date.now()): FetchLike {
  return async (input, init) => {
    const key = guardedReadKey(input, init);
    const wait = key ? readGuardDelay(key, now()) : 0;
    if (key && wait > 0) {
      if (!warned.has(key)) { warned.add(key); console.warn('同じ読み込みが続いているため間隔を空けます', key.slice(0, 200)); }
      await pause(wait, init?.signal);
    }
    return base(input, init);
  };
}
