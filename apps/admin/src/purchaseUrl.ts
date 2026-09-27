type Reference = { marketplace: string; itemId: string; url: string };
const rules = [
  { marketplace: 'メルカリ', hosts: ['jp.mercari.com', 'www.mercari.com'], path: /^\/(?:jp\/)?item\/(m\d+)\/?$/, id: /^m\d+$/i, base: 'https://jp.mercari.com/item/' },
  { marketplace: 'ヤフオク', hosts: ['auctions.yahoo.co.jp', 'page.auctions.yahoo.co.jp'], path: /^\/jp\/auction\/([a-z]\d+)\/?$/, id: /^[a-z]\d+$/i, base: 'https://auctions.yahoo.co.jp/jp/auction/' },
  { marketplace: 'ヤフフリ', hosts: ['paypayfleamarket.yahoo.co.jp'], path: /^\/item\/([a-z]\d+)\/?$/, id: /^[a-z]\d+$/i, base: 'https://paypayfleamarket.yahoo.co.jp/item/' },
  { marketplace: 'ラクマ', hosts: ['item.fril.jp'], path: /^\/([a-f0-9]{32})\/?$/i, id: /^[a-f0-9]{32}$/i, base: 'https://item.fril.jp/' },
];

/** Recognize a pasted public product URL; never turn an order number into a product URL. */
export function parsePurchaseUrl(input: string): Reference | null {
  try {
    const url = new URL(input.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    for (const rule of rules) {
      if (!rule.hosts.includes(url.hostname)) continue;
      const id = rule.path.exec(url.pathname)?.[1]?.toLowerCase();
      if (id) return { marketplace: rule.marketplace, itemId: id, url: rule.base + id };
    }
  } catch { /* A partial entry or an item ID is not a URL. */ }
  return null;
}

export function buildPurchaseUrl(marketplace: string, input: string): Reference | null {
  const name = marketplace === 'PayPayフリマ' ? 'ヤフフリ' : marketplace;
  const parsed = parsePurchaseUrl(input);
  if (parsed) return parsed.marketplace === name ? parsed : null;
  const rule = rules.find(rule => rule.marketplace === name);
  const id = input.trim().toLowerCase();
  return rule?.id.test(id) ? { marketplace: name, itemId: id, url: rule.base + id } : null;
}
