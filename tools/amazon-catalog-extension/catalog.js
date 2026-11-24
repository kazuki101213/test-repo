import { API, PUBLIC_KEY } from './public-config.js';
import {
  PRODUCT_GENRES, PRODUCT_TURNOVER,
  PRODUCT_SHIPPING_CATEGORIES, PRODUCT_SHIPPING_SIZES,
} from './product-estimates.js';

const adminOrigins = [
  'https://test-repo-delivery.vercel.app',
  'https://bussan-delivery.vercel.app',
  'https://bussan-admin.vercel.app',
];
const sessionKey = 'sb-' + new URL(API).hostname.split('.')[0] + '-auth-token';
const loginRequired = () => Object.assign(
  new Error('管理アプリのログインが必要です。'), { code: 'login-required' });
const adminPatterns = adminOrigins.map(origin => origin + '/*');
const columns = 'id,asin,product_no,model_no,maker,genre,turnover,list_price,payout_estimate,target_profit_rate,is_active,owner_staff_id,color,variant_label,variant_no,shipping_category,shipping_size';
const optionColumns = 'id,product_id,variant_no,label,list_price,payout_estimate,target_profit_rate,is_active';
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
let sessionLookup;
let retryInBackgroundAfter = 0;

export function validateAsin(asin) {
  if (typeof asin !== 'string' || !/^[A-Z0-9]{10}$/.test(asin)) throw new Error('ASINを確認できません。');
  return asin;
}

async function readTabSession(tabId) {
  try {
    const [entry] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [sessionKey, adminOrigins],
      func: (key, origins) => {
        if (!origins.includes(location.origin)) return null;
        try {
          const session = JSON.parse(localStorage.getItem(key));
          if (!session?.user?.id || !session?.access_token || !Number.isFinite(session.expires_at)) return null;
          if (session.expires_at * 1000 <= Date.now() + 5000) return { refreshing: true };
          return { userId: session.user.id, token: session.access_token, expiresAt: session.expires_at };
        } catch { return null; }
      },
    });
    return entry.result ?? null;
  } catch { return null; }
}

async function readSessionInBackground(origin) {
  let tabId;
  try {
    ({ id: tabId } = await chrome.tabs.create({ url: origin + '/', active: false }));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && adminOrigins.some(item => tab.url?.startsWith(item + '/'))) {
        const session = await readTabSession(tabId);
        if (!session?.refreshing) return session;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  } catch {
    return null;
  } finally {
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && !tab.active) await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

async function findSession() {
  const tabs = await chrome.tabs.query({ url: adminPatterns });
  const valid = (await Promise.all(tabs.map(tab => readTabSession(tab.id)))).filter(session => session?.token);
  if (!valid.length && Date.now() >= retryInBackgroundAfter) {
    for (const origin of adminOrigins) {
      const session = await readSessionInBackground(origin);
      if (session) return session;
    }
    retryInBackgroundAfter = Date.now() + 15000;
  }
  if (!valid.length) throw loginRequired();
  if (new Set(valid.map(session => session.userId)).size > 1) {
    throw new Error('複数のアカウントでログインしています。登録に使う管理アプリのアカウントだけを開いてください。');
  }
  return valid.sort((left, right) => right.expiresAt - left.expiresAt)[0];
}

function getSession() {
  sessionLookup ??= findSession().finally(() => { sessionLookup = undefined; });
  return sessionLookup;
}

async function request(path, session, options = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      ...options,
      headers: {
        apikey: PUBLIC_KEY,
        Authorization: 'Bearer ' + session.token,
        'Accept-Profile': 'app',
        'Content-Profile': 'app',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch { throw new Error('管理アプリとの通信に失敗しました。登録状況を確認してから再操作してください。'); }
  const data = await response.json().catch(() => null);
  if (response.status === 401) throw loginRequired();
  if (!response.ok || data === null) {
    if (data?.code === '23505') throw new Error('同じASINは登録済みです。商品リストを確認してください。');
    if (data?.message === '商品リストの管理者は自動で設定されます。') {
      throw new Error('別の管理者へ登録するには、管理アプリ側の更新が必要です。');
    }
    if (path === '/functions/v1/amazon-catalog-estimate' && typeof data?.error === 'string') {
      throw new Error(data.error);
    }
    if (response.status === 403) throw new Error('商品リストを登録できるアカウントでログインしてください。');
    throw new Error('管理アプリで処理できませんでした。登録状況を確認してから再操作してください。');
  }
  return data;
}

async function find(asin, session) {
  const params = new URLSearchParams({ asin: 'eq.' + asin, select: columns, limit: '1' });
  const rows = await request('/rest/v1/products?' + params, session);
  return rows[0] ?? null;
}

// 2026-11-25 通信削減：管理者一覧と自分の担当者は商品ページを開くたびに読まず、10分間使い回す（ログイン先が変われば読み直す）。
const reuseMs = 10 * 60 * 1000;
let ownersCache = null;
const makerCache = new Map();

async function catalogOwners(session) {
  if (ownersCache?.userId === session.userId && Date.now() - ownersCache.at < reuseMs) return ownersCache.scope;
  const profiles = new URLSearchParams({ select: 'staff_id', user_id: 'eq.' + session.userId, limit: '1' });
  const [owners, profile] = await Promise.all([
    request('/rest/v1/staff?select=id,code,name,display_name&role=eq.admin&is_active=eq.true&order=code', session),
    request('/rest/v1/profiles?' + profiles, session),
  ]);
  const current = owners.find(owner => owner.id === profile[0]?.staff_id);
  const original = owners.find(owner => owner.code === 'AA');
  const scope = { owners, defaultOwner: current ?? original, canChooseOwner: Boolean(current) };
  ownersCache = { userId: session.userId, at: Date.now(), scope };
  return scope;
}

function selectedOwner(scope, session, preference) {
  const saved = preference?.userId === session.userId
    ? scope.owners.find(owner => owner.id === preference.ownerId)
    : null;
  return saved && (scope.canChooseOwner || saved.id === scope.defaultOwner?.id) ? saved : scope.defaultOwner;
}

export async function catalogOwnerPreference(preference, requestedId) {
  const session = await getSession();
  const scope = await catalogOwners(session);
  if (requestedId !== undefined && !scope.owners.some(owner =>
    owner.id === requestedId && (scope.canChooseOwner || owner.id === scope.defaultOwner?.id))) {
    throw new Error('登録できる管理者を選んでください。');
  }
  return {
    owners: scope.canChooseOwner ? scope.owners : scope.owners.filter(owner => owner.id === scope.defaultOwner?.id),
    ownerId: requestedId ?? selectedOwner(scope, session, preference)?.id ?? '',
    userId: session.userId,
  };
}

const makerAliases = [
  ['Panasonic', 'パナソニック'], ['Sony', 'ソニー'], ['Sharp', 'シャープ'],
  ['Toshiba', '東芝'], ['Hitachi', '日立'], ['Makita', 'マキタ'], ['Canon', 'キヤノン', 'キャノン'],
];

const makerForms = value => value.normalize('NFKC').split(/[()]/).map(part => part.trim()).filter(Boolean);
const makerIdentity = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

async function lookupMaker(value, ownerId, session) {
  const forms = makerForms(value);
  const identities = new Set(forms.map(makerIdentity).filter(Boolean));
  for (const group of makerAliases) {
    if (group.some(name => identities.has(makerIdentity(name)))) {
      forms.push(...group);
      for (const name of group) identities.add(makerIdentity(name));
    }
  }
  const terms = [...new Set(forms.flatMap(form => form.match(/[\p{L}\p{N}]{2,40}/gu) ?? [])
    .map(term => term.toLowerCase()))].slice(0, 12);
  if (!terms.length) return '';
  const params = new URLSearchParams({
    select: 'maker,owner_staff_id', is_active: 'eq.true',
    or: '(' + terms.map(term => 'maker.ilike.*' + term + '*').join(',') + ')',
    order: 'maker,id', limit: '1000',
  });
  // 同じメーカー名の照会は10分間使い回す（商品ページを移るたびに同じ一覧を読まない）。
  const cacheKey = session.userId + '|' + params;
  const cached = makerCache.get(cacheKey);
  const rows = cached && Date.now() - cached.at < reuseMs ? cached.rows : await request('/rest/v1/products?' + params, session);
  if (rows !== cached?.rows) {
    if (makerCache.size > 50) makerCache.clear();
    makerCache.set(cacheKey, { at: Date.now(), rows });
  }
  const counts = new Map();
  for (const row of rows) {
    const parts = makerForms(row.maker ?? '').map(makerIdentity);
    if (!parts.length || !parts.every(part => identities.has(part))) continue;
    const count = counts.get(row.maker) ?? { parts: parts.length, total: 0, owner: 0 };
    count.total++;
    if (row.owner_staff_id === ownerId) count.owner++;
    counts.set(row.maker, count);
  }
  if (identities.has('panasonic') && counts.has('Panasonic')) return 'Panasonic';
  return [...counts].sort((a, b) => a[1].parts - b[1].parts || b[1].owner - a[1].owner ||
    b[1].total - a[1].total || a[0].length - b[0].length || a[0].localeCompare(b[0], 'ja'))[0]?.[0] ?? '';
}

// 同じ番号の通り（色違いの商品の行と、付属品・状態違いの通り）。
// 登録済みならその番号、未登録なら登録先の管理者の同じ型番を探す。読めないとき（古いDBなど）は通りなしで続ける。
async function catalogGroup(product, ownerId, model, session) {
  let rows = [];
  if (product?.product_no != null) {
    rows = await request('/rest/v1/products?' + new URLSearchParams({
      select: columns, product_no: 'eq.' + product.product_no, is_active: 'eq.true', order: 'variant_no,id' }), session);
  } else if (!product && ownerId && String(model ?? '').trim()) {
    const exact = String(model).trim().replace(/[\\%_*]/g, '\\$&');
    rows = await request('/rest/v1/products?' + new URLSearchParams({
      select: columns, owner_staff_id: 'eq.' + ownerId, is_active: 'eq.true', model_no: 'ilike.' + exact,
      order: 'product_no,variant_no,id' }), session);
    if (rows.length) rows = rows.filter(row => row.product_no === rows[0].product_no);
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const ids = rows.map(row => row.id).filter(id => uuidPattern.test(id));
  const options = ids.length ? await request('/rest/v1/product_options?' + new URLSearchParams({
    select: optionColumns, product_id: 'in.(' + ids.join(',') + ')', is_active: 'eq.true', order: 'variant_no' }), session) : [];
  const items = [
    ...rows.map(row => ({ kind: 'product', ...row, label: row.variant_label })),
    ...(Array.isArray(options) ? options : []).map(option => {
      const owner = rows.find(row => row.id === option.product_id);
      return { kind: 'option', ...option, asin: owner?.asin, color: owner?.color, owner_staff_id: owner?.owner_staff_id };
    }),
  ].sort((a, b) => (a.variant_no ?? 1) - (b.variant_no ?? 1));
  return { productNo: rows[0].product_no, first: rows[0], items };
}

export async function catalogLookup(asin, preference, maker, model) {
  validateAsin(asin);
  const session = await getSession();
  const [product, scope] = await Promise.all([find(asin, session), catalogOwners(session)]);
  const selected = selectedOwner(scope, session, preference);
  const group = await catalogGroup(product, selected?.id, model, session).catch(() => null);
  return {
    product,
    group,
    owners: scope.owners,
    ownerId: selected?.id ?? '',
    maker: !product && selected && maker ? await lookupMaker(maker, selected.id, session).catch(() => '') : '',
    canRegister: Boolean(selected && (scope.canChooseOwner || selected.id === scope.defaultOwner?.id)),
    userId: session.userId,
  };
}

function optionalChoice(value, allowed, label) {
  if (value && !allowed.includes(value)) throw new Error(label + 'を選び直してください。');
  return value || null;
}

function parseListPrice(value) {
  const priceText = String(value ?? '').trim();
  const price = priceText ? Number(priceText) : null;
  if (priceText && (!/^\d+$/.test(priceText) || !Number.isSafeInteger(price) || price > 2147483647)) {
    throw new Error('販売想定金額は0円以上の整数で入力してください。');
  }
  return price;
}

// 利益率（%）。空欄ならnull＝決まりの割合（1万円以下23%・5万円以下20%・5万円超17%）。
function parseProfitRate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d{1,2}$/.test(text)) throw new Error('利益率は0〜99の整数（%）で入力してください。');
  return Number(text);
}

export function targetCostFor(payout, profitRate) {
  const rate = profitRate ?? (payout <= 10000 ? 23 : payout <= 50000 ? 20 : 17);
  return Math.round(payout * (100 - rate) / 100);
}

export function productRow(asin, input) {
  validateAsin(asin);
  const price = parseListPrice(input.list_price);
  const profitRate = parseProfitRate(input.target_profit_rate);
  const genre = optionalChoice(input.genre, PRODUCT_GENRES, 'ジャンル');
  return {
    asin,
    model_no: String(input.model_no ?? '').trim().slice(0, 160) || null,
    maker: String(input.maker ?? '').trim().slice(0, 160) || null,
    genre,
    turnover: optionalChoice(input.turnover, PRODUCT_TURNOVER, '回転'),
    list_price: price,
    target_profit_rate: profitRate,
    color: String(input.color ?? '').trim().slice(0, 40) || null,
    variant_label: String(input.variant_label ?? '').trim().slice(0, 80) || null,
    shipping_category: optionalChoice(input.shipping_category, PRODUCT_SHIPPING_CATEGORIES.map(option => option.value), 'サイズ区分'),
    shipping_size: optionalChoice(input.shipping_size, PRODUCT_SHIPPING_SIZES, '配送サイズ'),
  };
}

// Amazonの手数料見積もり（Amazon2）から振込想定金額・仕入れ目標金額を出す。登録時と価格変更時で共通。
async function estimateAmounts(asin, price, session, profitRate = null) {
  const estimate = await request('/functions/v1/amazon-catalog-estimate', session, {
    method: 'POST',
    body: JSON.stringify({ asin, price }),
    signal: AbortSignal.timeout(48000),
  });
  if (!Number.isSafeInteger(estimate.payout) || estimate.payout < 0 || estimate.payout > price) {
    throw new Error('Amazonの手数料見積もりを確認できませんでした。');
  }
  return { payout_estimate: estimate.payout, target_cost: targetCostFor(estimate.payout, profitRate) };
}

export async function catalogRegister(asin, input, userId, ownerId, preference) {
  const row = productRow(asin, input);
  const session = await getSession();
  if (session.userId !== userId) throw new Error('ログイン先が変わりました。商品ページを再読み込みしてください。');
  const scope = await catalogOwners(session);
  if (selectedOwner(scope, session, preference)?.id !== ownerId) {
    throw new Error('登録先が変わりました。登録状況を確認してから追加してください。');
  }
  if (!scope.owners.some(owner => owner.id === ownerId)) throw new Error('登録先の管理者を選び直してください。');
  if (ownerId !== scope.defaultOwner?.id) {
    if (!scope.canChooseOwner) throw new Error('別の管理者を選ぶには管理者アカウントでログインしてください。');
    row.owner_staff_id = ownerId;
  }
  const existing = await find(asin, session);
  if (existing) {
    // 登録済みのASIN：付属品・状態が違えば、その商品の通りとして追加する。同じなら登録済み。
    const label = row.variant_label ?? '';
    if (!existing.is_active || !label || label.toLowerCase() === String(existing.variant_label ?? '').trim().toLowerCase()) {
      return { product: existing, created: false };
    }
    const option = { product_id: existing.id, variant_no: 1, label, list_price: row.list_price, target_profit_rate: row.target_profit_rate };
    if (option.list_price !== null && option.list_price > 0) {
      Object.assign(option, await estimateAmounts(asin, option.list_price, session, option.target_profit_rate));
    }
    const added = await request('/rest/v1/product_options?' + new URLSearchParams({ select: optionColumns }), session, {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(option),
    });
    if (added[0]?.product_id !== existing.id) throw new Error('保存先を確認できません。商品ページを再読み込みしてください。');
    return { product: existing, created: false, option: added[0] };
  }
  if (row.list_price !== null && row.list_price > 0) {
    Object.assign(row, await estimateAmounts(asin, row.list_price, session, row.target_profit_rate));
  }
  const params = new URLSearchParams({ select: columns });
  const rows = await request('/rest/v1/products?' + params, session, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (rows[0]?.asin !== asin || !rows[0].id || rows[0].owner_staff_id !== ownerId) {
    throw new Error('保存先を確認できません。商品ページを再読み込みしてください。');
  }
  return { product: rows[0], created: true };
}

export async function updateCatalogPrice(asin, { id, userId, previousPrice, price, previousRate = null, rate, payout = null }) {
  validateAsin(asin);
  const listPrice = parseListPrice(price);
  const profitRate = parseProfitRate(rate);
  const priceChanged = listPrice !== null && listPrice > 0 && listPrice !== previousPrice;
  const session = await getSession();
  if (session.userId !== userId) throw new Error('ログイン先が変わりました。登録状況を確認してください。');
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    (previousPrice !== null && !Number.isSafeInteger(previousPrice))) {
    throw new Error('登録状況を確認してから保存してください。');
  }
  const params = new URLSearchParams({
    select: columns, id: 'eq.' + id, asin: 'eq.' + asin, is_active: 'eq.true',
    list_price: previousPrice === null ? 'is.null' : 'eq.' + previousPrice,
    target_profit_rate: previousRate === null ? 'is.null' : 'eq.' + previousRate,
  });
  const rows = await request('/rest/v1/products?' + params, session, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      list_price: listPrice,
      target_profit_rate: profitRate,
      // 価格を変えた時だけAPIで計算し直す（同じ価格・空欄・0円なら振込はそのまま）。
      // 利益率だけ変えた時は、今の振込想定金額から仕入れ目標金額を計算し直す。
      ...(priceChanged ? await estimateAmounts(asin, listPrice, session, profitRate)
        : profitRate !== previousRate && Number.isSafeInteger(payout) ? { target_cost: targetCostFor(payout, profitRate) } : {}),
    }),
  });
  if (rows.length !== 1 || rows[0].id !== id || rows[0].list_price !== listPrice) {
    throw new Error('商品リストが変更されたか、編集権限がありません。登録状況を確認してください。');
  }
  return rows[0];
}

// 付属品・状態の通りの販売想定金額・利益率を保存する（商品の行と同じ計算）。
export async function updateOptionPrice(asin, { id, userId, previousPrice, price, previousRate = null, rate, payout = null }) {
  validateAsin(asin);
  const listPrice = parseListPrice(price);
  const profitRate = parseProfitRate(rate);
  const priceChanged = listPrice !== null && listPrice > 0 && listPrice !== previousPrice;
  const session = await getSession();
  if (session.userId !== userId) throw new Error('ログイン先が変わりました。登録状況を確認してください。');
  if (typeof id !== 'string' || !uuidPattern.test(id) || (previousPrice !== null && !Number.isSafeInteger(previousPrice))) {
    throw new Error('登録状況を確認してから保存してください。');
  }
  const params = new URLSearchParams({
    select: optionColumns, id: 'eq.' + id, is_active: 'eq.true',
    list_price: previousPrice === null ? 'is.null' : 'eq.' + previousPrice,
    target_profit_rate: previousRate === null ? 'is.null' : 'eq.' + previousRate,
  });
  const rows = await request('/rest/v1/product_options?' + params, session, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      list_price: listPrice,
      target_profit_rate: profitRate,
      ...(priceChanged ? await estimateAmounts(asin, listPrice, session, profitRate)
        : profitRate !== previousRate && Number.isSafeInteger(payout) ? { target_cost: targetCostFor(payout, profitRate) } : {}),
    }),
  });
  if (rows.length !== 1 || rows[0].id !== id) throw new Error('商品リストが変更されたか、編集権限がありません。登録状況を確認してください。');
  return rows[0];
}
