export function asinFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['amazon.co.jp', 'www.amazon.co.jp'].includes(url.hostname)) return null;
    return url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=\/|$)/i)?.[1].toUpperCase() ?? null;
  } catch {
    return null;
  }
}

// Chrome serializes this function when it runs it in the Amazon tab.
export function readAmazonProduct(urlAsin, asinOnly = false) {
  const text = selector => document.querySelector(selector)?.textContent?.trim() || '';
  const clean = value => value.replace(/\s+/g, ' ').trim();
  const selected = ['#ASIN', '#twister input[name="ASIN"]', '#addToCart input[name="ASIN"]']
    .map(selector => document.querySelector(selector)?.value?.trim().toUpperCase())
    .find(value => /^[A-Z0-9]{10}$/.test(value || ''));
  if (asinOnly) return selected || urlAsin;
  const fields = new Map();
  const labelText = value => clean(value.replace(/[\u200e\u200f:：]/g, '')).normalize('NFKC');
  const detailTables = [
    '#productDetails_techSpec_section_1', '#productDetails_techSpec_section_2',
    '#productDetails_detailBullets_sections1', '#productOverview_feature_div',
    '#productDetails_expanderSectionTables',
  ];
  for (const row of document.querySelectorAll(detailTables.map(selector => selector + ' tr').join(', '))) {
    const cells = row.querySelectorAll(':scope > th, :scope > td');
    if (cells.length === 2) fields.set(labelText(cells[0].textContent), clean(cells[1].textContent));
  }
  for (const row of document.querySelectorAll('#detailBullets_feature_div li')) {
    const label = row.querySelector('.a-text-bold');
    const value = label?.nextElementSibling;
    if (value) fields.set(labelText(label.textContent), clean(value.textContent));
  }
  const field = labels => labels.map(label => fields.get(label)).find(Boolean) || '';
  const categories = [...document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a')]
    .map(link => clean(link.textContent));
  const packageText = field(['梱包サイズ', '梱包寸法', '商品パッケージの寸法', 'パッケージ寸法', 'Package Dimensions'])
    .normalize('NFKC');
  const dimensions = packageText.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(cm|mm|センチメートル|ミリメートル)/i);
  const weightText = packageText + '; ' + field(['梱包重量', 'パッケージ重量', 'Package Weight']).normalize('NFKC');
  const weight = weightText.match(/(\d+(?:\.\d+)?)\s*(kg|g|キログラム|グラム)\s*(?:$|[;、,.)）])/i);
  const packageInfo = dimensions && weight ? {
    sidesMm: dimensions.slice(1, 4).map(value => Number(value) * (/^(cm|センチメートル)$/i.test(dimensions[4]) ? 10 : 1)),
    weightG: Number(weight[1]) * (/^(kg|キログラム)$/i.test(weight[2]) ? 1000 : 1),
  } : null;
  const socialProof = document.querySelector('#socialProofingAsinFaceout_feature_div');
  const purchaseText = socialProof?.innerText?.match(/過去\s*[0-9０-９]+\s*か月(?:間)?で\s*[0-9０-９,，]+\s*点以上(?:が)?購入されました/u)?.[0] || '';
  const priceSelectors = [
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePrice_feature_div .priceToPay .a-offscreen',
    '#apex_desktop .priceToPay .a-offscreen',
    '#corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen',
    '#priceblock_dealprice', '#priceblock_ourprice', '#priceblock_saleprice',
  ];
  const amazonPrice = priceSelectors.map(selector => {
    const value = text(selector).normalize('NFKC');
    const match = value.match(/^(?:¥\s*([0-9][0-9,]*)(?:\.00)?|([0-9][0-9,]*)\s*円)$/);
    return match ? Number((match[1] ?? match[2]).replace(/,/g, '')) : null;
  }).find(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647) ?? null;
  return {
    asin: selected || urlAsin,
    title: text('#productTitle'),
    model: field(['商品モデル番号', '型番', '製品型番', 'モデル番号', '品番', 'メーカー型番', 'Item model number', 'Model Number']),
    maker: field(['メーカー', 'ブランド', 'Manufacturer', 'Brand']),
    categories,
    packageInfo,
    purchaseText,
    amazonPrice,
  };
}

