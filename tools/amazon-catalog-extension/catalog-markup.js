export function createCatalogMarkup() {
  function element(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }
  const button = (id, label, className = '') => element('button', { id, type: 'button', class: className }, label);
  const status = (id, label = '') => element('p', { id, role: 'status' }, label);
  const field = (label, tag, name, attributes = {}, className = '') =>
    element('label', className ? { class: className } : {}, label, element(tag, { name, ...attributes }));
  const rateAttributes = { type: 'number', min: '0', max: '99', step: '1', inputmode: 'numeric' };
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
          // 担当者（登録先）は型番と同じ行の右端に出し、パネルを1行低くする（2026-11-26）。
          element('p', { id: 'catalog-destination', class: 'meta' }),
          element('form', { id: 'catalog-price-form', hidden: '' },
            element('input', { ...priceAttributes, name: 'list_price', 'aria-label': '販売想定金額（円）' }),
            element('span', { 'aria-hidden': 'true' }, '円'),
            element('input', { ...rateAttributes, name: 'target_profit_rate', class: 'catalog-rate', placeholder: '利益率', 'aria-label': '利益率（%）' }),
            element('span', { 'aria-hidden': 'true' }, '%'),
            element('button', { id: 'save-catalog-price', type: 'submit', class: 'primary' }, '保存'))),
        element('div', { class: 'meta' },
          element('span', { id: 'asin' }), element('span', { id: 'amazon-purchases' })),
        element('div', { id: 'catalog-variants', hidden: '' }),
        element('form', { id: 'option-form', class: 'compact-fields', hidden: '' },
          element('input', { name: 'variant_label', maxlength: '80', placeholder: '付属品・状態', 'aria-label': '付属品・状態' }),
          element('input', { ...priceAttributes, name: 'list_price', class: 'money', placeholder: '金額', 'aria-label': '販売想定金額（円）' }),
          element('input', { ...rateAttributes, name: 'target_profit_rate', class: 'rate', placeholder: '利益率', 'aria-label': '利益率（%）' }),
          element('button', { id: 'add-option', type: 'submit', class: 'primary' }, '追加')),
        status('option-status'),
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
          element('div', { class: 'fields fields-twelve' },
            field('型番', 'input', 'model_no', { maxlength: '160', placeholder: '型番' }, 'span-6 base-field'),
            field('メーカー', 'input', 'maker', { maxlength: '160', placeholder: 'メーカー' }, 'span-6 base-field'),
            field('ジャンル', 'select', 'genre', {}, 'span-6 base-field'),
            field('回転', 'select', 'turnover', {}, 'span-6 base-field'),
            field('サイズ区分', 'select', 'shipping_category', {}, 'span-6 base-field'),
            field('色', 'input', 'color', { maxlength: '40', placeholder: '色（任意）' }, 'span-6 color-field'),
            field('付属品・状態', 'input', 'variant_label', { maxlength: '80', placeholder: '付属品・状態（任意）' }, 'span-6 label-field'),
            field('販売想定金額（円）', 'input', 'list_price', { ...priceAttributes, placeholder: '金額' }, 'span-3 money-field'),
            field('利益率（%）', 'input', 'target_profit_rate', { ...rateAttributes, placeholder: '利益率' }, 'span-3 rate-field')),
          element('button', { id: 'register', type: 'submit', class: 'primary' }, '追加')))));
}
