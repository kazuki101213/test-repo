(() => {
  const norm = value => (value || '').normalize('NFKC').replace(/[\t　 ]+/g, ' ').trim();
  const labelValue = (lines, pattern) => {
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      const inline = norm(match[1]);
      if (inline) return inline;
      const next = lines[index + 1];
      if (next && !/^(出品者情報|落札者情報|お届け先|購入者情報|(?:氏名|名前|お名前|住所|所在地|発送元住所)[：:]?)$/.test(next)) return norm(next);
    }
    return '';
  };
  function prefectureCity(address) {
    const value = norm(address).replace(/[〒\d０-９\-－ー〒]/g, '');
    const match = value.match(/^(北海道|東京都|京都府|大阪府|.{2,3}県)([^0-9０-９]{1,20}?(?:市|区|町|村))/u);
    return match ? `${match[1]}${match[2]}` : '';
  }
  function parse(text) {
    const lines = String(text || '').normalize('NFKC').split(/\r?\n/).map(norm).filter(Boolean);
    const shipping = lines.some(line => /^(?:(?:配送|発送)方法|配送の方法)[：:]?\s*定形外郵便(?:$|[（( ])/.test(line)
      || /^定形外郵便(?:$|[（( ])/.test(line));
    if (!shipping) return { shippingMethod: null, senderName: null, senderPrefectureCity: null };
    const sellerStart = lines.findIndex(line => /^(?:出品者情報|出品者の情報|出品者情報を確認)$/.test(line));
    if (sellerStart < 0) return { shippingMethod: '定形外郵便', senderName: null, senderPrefectureCity: null };
    const end = lines.findIndex((line, index) => index > sellerStart && /^(?:落札者情報|購入者情報|お届け先|配送先情報)$/.test(line));
    const sellerLines = lines.slice(sellerStart + 1, end < 0 ? sellerStart + 40 : end);
    const senderName = labelValue(sellerLines, /^(?:出品者)?(?:氏名|名前|お名前)[：:]?\s*(.*)$/);
    const address = labelValue(sellerLines, /^(?:出品者)?(?:住所|所在地|発送元住所)[：:]?\s*(.*)$/);
    return { shippingMethod: '定形外郵便', senderName: senderName || null, senderPrefectureCity: prefectureCity(address) || null };
  }
  globalThis.FleaYahooUntrackedSender = Object.freeze({ parse, prefectureCity });
})();
