const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

function nonnegative(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function keepaSummary(product) {
  const stats = product.stats ?? {};
  const sidesMm = [product.packageLength, product.packageWidth, product.packageHeight];
  const weightG = product.packageWeight;
  return {
    title: product.title || '',
    model: product.model || '',
    maker: product.manufacturer || product.brand || '',
    categories: Array.isArray(product.categoryTree)
      ? product.categoryTree.map(category => category?.name).filter(name => typeof name === 'string')
      : [],
    packageInfo: [...sidesMm, weightG].every(value => Number.isFinite(value) && value > 0)
      ? { sidesMm, weightG }
      : null,
    monthlySold: nonnegative(product.monthlySold),
    drops30: nonnegative(stats.salesRankDrops30),
    drops90: nonnegative(stats.salesRankDrops90),
    new30: nonnegative(stats.avg30?.[1]),
    used30: nonnegative(stats.avg30?.[2]),
    new90: nonnegative(stats.avg90?.[1]),
    used90: nonnegative(stats.avg90?.[2]),
  };
}

function quotaFromResponse(body, status, now) {
  const tokens = Number.isInteger(body?.tokensLeft) ? body.tokensLeft : null;
  const rate = Number.isInteger(body?.refillRate) && body.refillRate > 0 ? body.refillRate : 1;
  const interval = Number.isInteger(body?.refillIn) && body.refillIn > 0 ? body.refillIn : MINUTE;
  const blocked = status === 429 || (tokens !== null && tokens <= 0);
  return {
    tokens,
    measuredAt: now,
    blockedUntil: blocked ? now + interval + Math.floor(Math.max(0, -(tokens ?? 0)) / rate) * MINUTE : 0,
  };
}

function fromCache(entry, quota, now, status = 'cached') {
  const usable = entry && now - entry.savedAt <= MAX_CACHE_AGE ? entry : null;
  return { status, quota, entry: usable };
}

export async function lookupKeepa(asin, storage, request = fetch, clock = Date.now) {
  const { keepaKey, keepaQuota, keepaCache = {} } = await storage.get(['keepaKey', 'keepaQuota', 'keepaCache']);
  const now = clock();
  const previous = Object.hasOwn(keepaCache, asin) ? keepaCache[asin] : null;
  if (previous?.data && Object.hasOwn(previous.data, 'packageInfo') && now - previous.savedAt < CACHE_TTL) {
    return fromCache(previous, keepaQuota, now);
  }
  if (!keepaKey) return fromCache(previous, keepaQuota, now, 'missing-key');
  if (keepaQuota?.blockedUntil > now) return fromCache(previous, keepaQuota, now, 'waiting');

  const params = new URLSearchParams({ key: keepaKey, domain: '5', asin, stats: '90', days: '90' });
  let response;
  try {
    response = await request('https://api.keepa.com/product?' + params, {
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch { return fromCache(previous, keepaQuota, clock(), 'unavailable'); }

  const body = await response.json().catch(() => null);
  const receivedAt = clock();
  const quota = quotaFromResponse(body, response.status, receivedAt);
  if (response.status === 429) {
    await storage.set({ keepaQuota: quota });
    return fromCache(previous, quota, receivedAt, 'waiting');
  }
  if ([400, 401, 403].includes(response.status)) return fromCache(previous, keepaQuota, receivedAt, 'key-rejected');
  if (!response.ok || !body || body.error || !Array.isArray(body.products)) {
    return fromCache(previous, keepaQuota, receivedAt, 'unavailable');
  }

  const product = body.products.find(item => item.asin === asin && item.domainId === 5);
  if (!product) {
    await storage.set({ keepaQuota: quota });
    return fromCache(previous, quota, receivedAt, 'not-found');
  }
  const entry = { savedAt: receivedAt, data: keepaSummary(product) };
  const cache = Object.fromEntries(Object.entries({ ...keepaCache, [asin]: entry })
    .filter(([, item]) => receivedAt - item.savedAt <= MAX_CACHE_AGE)
    .sort(([, left], [, right]) => right.savedAt - left.savedAt)
    .slice(0, 100));
  await storage.set({ keepaCache: cache, keepaQuota: quota });
  return { status: 'fetched', entry, quota };
}
