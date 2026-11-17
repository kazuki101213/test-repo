import {
  PRODUCT_GENRES, PRODUCT_TURNOVER, PRODUCT_SHIPPING_CATEGORIES,
} from './product-estimates.js';
import { catalogShippingSize, shippingCategory } from './shipping.js';

export function mountCatalogView(root) {
  const $ = selector => root.querySelector(selector);
  const form = $('#registration');
  const fields = form.elements;
  const priceForm = $('#catalog-price-form');
  const priceInput = priceForm.elements.list_price;
  const savePrice = $('#save-catalog-price');
  const loginLink = $('#catalog-login');
  const format = new Intl.NumberFormat('ja-JP');
  const dateFormat = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const yen = value => value === null ? '—' : format.format(value) + '円';
  let product;
  let catalogItem;

  let userId;
  let ownerId = '';
  let owners = [];
  let canRegister = false;
  let quota;
  let packageInfo;
  let keepaBusy = false;
  let checking = false;
  let saving = false;
  let checkAgain = false;
  let keepaMessage = '';

  function options(name, values) {
    fields[name].add(new Option('未選択', ''));
    for (const item of values) {
      fields[name].add(typeof item === 'string' ? new Option(item, item) : new Option(item.label, item.value));
    }
  }
  options('genre', PRODUCT_GENRES);
  options('turnover', PRODUCT_TURNOVER);
  options('shipping_category', PRODUCT_SHIPPING_CATEGORIES);

  async function send(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw Object.assign(
      new Error(response?.message || '拡張機能との通信に失敗しました。'), { code: response?.code });
    return response.data;
  }

  function showModel() {
    const model = fields.model_no.value.trim();
    $('#model-display').textContent = model;
    $('#model-display').hidden = !model;
  }
  fields.model_no.addEventListener('input', showModel);
  function suggestShipping(keepa) {
    packageInfo = keepa?.packageInfo ?? packageInfo ?? product.packageInfo;
    if (!fields.shipping_category.value) {
      const categories = [...product.categories, ...(keepa?.categories ?? [])];
      fields.shipping_category.value = shippingCategory(categories, product.title || keepa?.title || '', packageInfo);
    }
  }
  $('#settings').addEventListener('click', () => void send('open-options').catch(error => { keepaMessage = error.message; updateKeepaStatus(); }));

  function showCatalog(item) {
    catalogItem = item;
    priceForm.hidden = !item?.is_active;
    priceInput.value = item?.list_price ?? product.amazonPrice ?? '';
    $('#catalog-price-status').textContent = '';
    $('#catalog-message').textContent = '';
    const status = $('#catalog-status');
    status.dataset.registration = item ? (item.owner_staff_id === ownerId ? 'registered' : 'other-owner') :
      (canRegister ? 'unregistered' : '');
    status.textContent = item ? (item.is_active ? '登録済み' : '登録済み（無効）') : (canRegister ? '未登録' : '');
    $('#catalog-number').textContent = item?.product_no == null ? '' : '品番 ' + item.product_no;
    if (item && !fields.model_no.value && item.model_no) {
      fields.model_no.value = item.model_no;
      showModel();
    }
    if (item && item.owner_staff_id !== ownerId) {
      const owner = owners.find(candidate => candidate.id === item.owner_staff_id);
      $('#catalog-message').textContent = (owner?.display_name || owner?.name || '別の管理者') + 'の商品リストに登録されています。';
    } else if (!item && !canRegister) {
      $('#catalog-message').textContent = '拡張機能のボタンから登録先の管理者を選んでください。';
    }
    form.hidden = Boolean(item) || !canRegister;
  }

  async function check() {
    if (!product) return;
    if (checking || saving) {
      checkAgain = true;
      return;
    }
    checking = true;
    $('#register').disabled = true;
    $('#catalog-message').textContent = '登録状況を確認しています…';
    try {
      const result = await send('catalog-lookup', { asin: product.asin });
      if (!Array.isArray(result?.owners)) {
        throw new Error('拡張機能を再読み込みしてから、Amazonの商品ページを更新してください。');
      }
      userId = result.userId;
      owners = result.owners;
      ownerId = result.ownerId;
      canRegister = result.canRegister;
      loginLink.hidden = true;
      showCatalog(result.product);
    } catch (error) {
      form.hidden = true;
      priceForm.hidden = true;
      catalogItem = null;
      loginLink.hidden = error.code !== 'login-required';
      delete $('#catalog-status').dataset.registration;
      $('#catalog-status').textContent = '';
      $('#catalog-number').textContent = '';
      $('#catalog-message').textContent = error.message;
    } finally {
      checking = false;
      $('#register').disabled = false;
      if (checkAgain) {
        checkAgain = false;
        void check();
      }
    }
  }

  function displayMetrics(entry) {
    const metrics = $('#keepa-metrics');
    const { data } = entry;
    const values = [
      ['過去1か月の購入表示', data.monthlySold === null ? '—' : format.format(data.monthlySold) + '点以上'],
      ['ランキング降下回数（30日 / 90日）', [data.drops30, data.drops90].map(value => value === null ? '—' : value + '回').join(' / ')],
      ['新品の平均価格（30日 / 90日）', [data.new30, data.new90].map(yen).join(' / ')],
      ['中古の平均価格（30日 / 90日）', [data.used30, data.used90].map(yen).join(' / ')],
    ];
    metrics.replaceChildren(...values.flatMap(([label, value]) => {
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      return [term, description];
    }));
    metrics.hidden = false;
    if (!fields.model_no.value) fields.model_no.value = data.model;
    showModel();
    if (!fields.maker.value) fields.maker.value = data.maker;
    if (!fields.turnover.value && Number.isInteger(data.drops30) && data.drops30 >= 0) {
      fields.turnover.value = data.drops30 >= 20 ? '高' : data.drops30 <= 5 ? '低' : '中';
    }
    suggestShipping(data);
  }

  priceForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!catalogItem?.is_active || checking || saving) return;
    saving = true;
    const controls = [priceInput, savePrice];
    for (const control of controls) control.disabled = true;
    const status = $('#catalog-price-status');
    status.textContent = '保存しています…';
    try {
      const item = await send('catalog-update-price', {
        asin: product.asin, id: catalogItem.id, userId, previousPrice: catalogItem.list_price, price: priceInput.value,
      });
      showCatalog(item);
      status.textContent = '商品リストの販売想定金額を保存しました。';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      for (const control of controls) control.disabled = false;
      if (checkAgain) {
        checkAgain = false;
        void check();
      }
    }
  });

  function updateKeepaStatus() {
    const seconds = Math.max(0, Math.ceil(((quota?.blockedUntil ?? 0) - Date.now()) / 1000));
    $('#keepa').disabled = keepaBusy || seconds > 0;
    const remaining = Number.isInteger(quota?.tokens) ? ' ／ 前回の残り ' + quota.tokens + 'トークン' : '';
    $('#keepa-status').textContent = [keepaMessage, seconds ? '再取得まで約' + seconds + '秒。商品登録は続けられます。' : '']
      .filter(Boolean).join(' ') + remaining;
  }

  const keepaMessages = {
    fetched: 'Keepaから取得しました。',
    cached: '前回取得したデータを表示しています（トークン消費なし）。',
    waiting: 'トークンの回復待ちです。',
    'missing-key': '「Keepa設定」でAPIキーを登録してください。',
    'key-rejected': 'Keepa APIキーと利用枠を確認してください。',
    'not-found': 'KeepaにこのASINのデータが見つかりませんでした。',
    unavailable: 'Keepaとの通信に失敗しました。時間をおいて再取得できます。',
  };
  $('#keepa').addEventListener('click', async () => {
    keepaBusy = true;
    keepaMessage = 'Keepaを確認しています…';
    updateKeepaStatus();
    try {
      const result = await send('keepa-lookup', { asin: product.asin });
      quota = result.quota;
      keepaMessage = keepaMessages[result.status] || '';
      if (result.entry) {
        displayMetrics(result.entry);
        if (result.status !== 'fetched') keepaMessage += ' 取得日時 ' + dateFormat.format(result.entry.savedAt);
      }
    } catch (error) {
      keepaMessage = error.message;
    } finally {
      keepaBusy = false;
      updateKeepaStatus();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!product || !userId || !ownerId || !canRegister || checking || saving) return;
    saving = true;
    $('#register').disabled = true;
    $('#catalog-message').textContent = '登録しています…';
    try {
      const result = await send('catalog-register', {
        asin: product.asin, userId, ownerId, product: {
          ...Object.fromEntries(new FormData(form)),
          shipping_size: catalogShippingSize(fields.shipping_category.value, packageInfo),
        },
      });
      showCatalog(result.product);
    } catch (error) {
      $('#catalog-status').textContent = error.message;
    } finally {
      saving = false;
      $('#register').disabled = false;
      if (checkAgain) {
        checkAgain = false;
        void check();
      }
    }
  });

  async function initialize() {
    try {


      product = await send('read-page');
      $('#page-status').hidden = true;
      $('#product').hidden = false;
      $('#asin').textContent = product.asin;
      $('#amazon-purchases').textContent = product.purchaseText;
      $('#amazon-purchases').hidden = !product.purchaseText;
      if (product.amazonPrice !== null) priceInput.title = 'Amazonの表示価格 ' + yen(product.amazonPrice);
      $('#chart').href = 'https://keepa.com/#!product/5-' + product.asin;
      fields.model_no.value = product.model;
      showModel();
      fields.maker.value = product.maker;
      suggestShipping();
      const normalized = value => value.normalize('NFKC').replace(/\s/g, '');
      fields.genre.value = PRODUCT_GENRES.find(genre => product.categories.some(category => normalized(genre) === normalized(category))) || '';
      void check();
    } catch (error) {
      $('#page-status').textContent = error.message;
    }
  }
  const timer = setInterval(updateKeepaStatus, 1000);
  const refreshOnFocus = () => {
    if (!document.hidden && !checking && !saving) void check();
  };
  document.addEventListener('visibilitychange', refreshOnFocus);
  window.addEventListener('focus', refreshOnFocus);
  void initialize();
  return {
    refresh: check,
    dispose() {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      window.removeEventListener('focus', refreshOnFocus);
    },
  };
}
