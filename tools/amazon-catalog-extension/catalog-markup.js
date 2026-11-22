export function createCatalogMarkup() {
  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }
  const button = (id, label, className = '') => element('button', { id, type: 'button', class: className }, label);
  const status = (id, label = '') => element('p', { id, role: 'status' }, label);
  const field = (label, tag, name, attributes = {}) =>
    element('label', {}, label, element(tag, { name, ...attributes }));
  const priceAttributes = { type: 'number', min: '0', max: '2147483647', step: '1', inputmode: 'numeric' };

  return element('main', {},
    element('header', {},
      element('h1', {}, '商品リスト', element('span', { id: 'catalog-status', role: 'status' }), element('span', { id: 'catalog-number', class: 'meta' })),
      button('settings', 'Keepa設定', 'link')),
    element('div', { id: 'catalog-panel-body' },
      status('page-status', '商品情報を読み込んでいます…'),
      element('section', { id: 'product', hidden: '' },
        element('div', { id: 'catalog-summary' },
          element('p', { id: 'model-display', class: 'product-title', hidden: '' }),
          element('form', { id: 'catalog-price-form', hidden: '' },
            element('input', { ...priceAttributes, name: 'list_price', 'aria-label': '販売想定金額（円）' }),
            element('span', { 'aria-hidden': 'true' }, '円'),
            element('button', { id: 'save-catalog-price', type: 'submit', class: 'primary' }, '保存'))),
        element('div', { class: 'meta' },
          element('span', { id: 'asin' }), element('span', { id: 'amazon-purchases' })),
        status('catalog-message'),
        element('a', { id: 'catalog-login', href: 'https://test-repo-delivery.vercel.app/', target: '_blank',
          rel: 'noopener noreferrer', hidden: '' }, '管理アプリでログイン'),
        status('catalog-price-status'),
        element('section', { class: 'keepa' },
          element('div', { class: 'status-row' },
            button('keepa', 'Keepaデータを取得'),
            element('a', { id: 'chart', target: '_blank', rel: 'noopener noreferrer' }, 'Keepaでグラフを見る')),
          status('keepa-status'),
          element('dl', { id: 'keepa-metrics', hidden: '' })),
        element('form', { id: 'registration', hidden: '' },
          element('div', { class: 'fields' },
            field('型番', 'input', 'model_no', { maxlength: '160' }),
            element('div', {},
              field('メーカー', 'input', 'maker', { maxlength: '160' }),
              element('p', { id: 'catalog-destination', class: 'meta' })),
            field('ジャンル', 'select', 'genre'),
            field('回転', 'select', 'turnover'),
            field('サイズ区分', 'select', 'shipping_category'),
            field('販売想定金額（円）', 'input', 'list_price', priceAttributes)),
          element('button', { id: 'register', type: 'submit', class: 'primary' }, '商品リストに追加')))));
}
