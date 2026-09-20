/**
 * 各フリマ/オークションサイトの「購入した取引」から追跡番号を拾うための設定。
 *
 * どのサイトも購入者向けの API は公開していないので、ログイン済みブラウザで
 * 取引ページを開いて本文から拾う。DOM 構造は予告なく変わるため、
 * CSS セレクタに依存するのは「取引ページへのリンク集め」だけに留めて、
 * 追跡番号そのものはページ全文に対する正規表現で拾う。
 * そのほうが改装に強い。
 */

// ---------------------------------------------------------------------------
// 追跡番号の抽出
// ---------------------------------------------------------------------------

/** ラベル付きで書かれている場合（最優先。これが取れたらほぼ確実） */
const LABELLED = [
  /(?:お問い?合わ?せ番号|問合せ番号)\s*[:：]?\s*([0-9][0-9\- ]{9,})/,
  /(?:伝票番号|送り状番号|追跡番号|配送番号)\s*[:：]?\s*([0-9][0-9\- ]{9,})/,
];

/** ラベルが無い場合の形状マッチ（誤検出しうるので候補扱い） */
const SHAPED = [
  { carrier: 'ヤマト運輸', re: /\b(\d{4}[- ]\d{4}[- ]\d{4})\b/ },
  { carrier: 'ヤマト運輸', re: /\b(\d{12})\b/ },
  { carrier: '日本郵便', re: /\b(\d{11})\b/ },
];

/** 配送業者を本文から推定する */
function guessCarrier(text, number) {
  if (/ヤマト|クロネコ|宅急便|ネコポス/.test(text)) return 'ヤマト運輸';
  if (/日本郵便|ゆうパック|ゆうパケット|郵便局/.test(text)) return '日本郵便';
  const digits = String(number).replace(/[^0-9]/g, '');
  if (digits.length === 12) return 'ヤマト運輸';
  if (digits.length === 11) return '日本郵便';
  return '';
}

/**
 * ページ全文から追跡番号を 1 件抜く。
 * @returns {{number:string, carrier:string, confidence:'high'|'low'}|null}
 */
export function extractTracking(text) {
  if (!text) return null;

  for (const re of LABELLED) {
    const hit = text.match(re);
    if (hit) {
      const number = hit[1].replace(/[\s-]/g, '');
      if (number.length >= 10 && number.length <= 14) {
        return { number, carrier: guessCarrier(text, number), confidence: 'high' };
      }
    }
  }

  // 匿名配送だと番号自体が出ない。その場合ここには来ない（null を返す）。
  for (const { carrier, re } of SHAPED) {
    const hit = text.match(re);
    if (hit) {
      const number = hit[1].replace(/[\s-]/g, '');
      return { number, carrier: guessCarrier(text, number) || carrier, confidence: 'low' };
    }
  }

  return null;
}

/** 配送状況を拾う（番号が取れない匿名配送でも、ここだけは取れることが多い） */
export function extractStatus(text) {
  if (!text) return '';
  const patterns = [
    /(発送済み|発送通知済み|配達完了|お届け済み|配達中|輸送中|持ち出し中|集荷済み|受付済み|発送準備中)/,
    /(取引完了|評価待ち|入金待ち|発送をお待ちください)/,
  ];
  for (const re of patterns) {
    const hit = text.match(re);
    if (hit) return hit[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// サイト定義
// ---------------------------------------------------------------------------

/**
 * listUrls      購入履歴の一覧ページ（複数ページあるものは配列で並べる）
 * linkSelector  一覧から取引ページの URL を集めるセレクタ
 * linkPattern   集めた URL のうち取引ページだけを残すパターン
 * itemIdFrom    取引ページから商品ID（スプレッドシートの D 列）を取り出す
 * loginCheck    ログイン済みか判定する（未ログインだと一覧が空で返るため）
 */
export const SITES = {
  メルカリ: {
    key: 'mercari',
    listUrls: ['https://jp.mercari.com/mypage/purchases'],
    linkSelector: 'a[href*="/transaction/"]',
    linkPattern: /\/transaction\/[A-Za-z0-9_-]+/,
    loginCheck: (text) => !/ログイン|会員登録/.test(text.slice(0, 2000)),
    // 取引ページ内の商品リンク /item/m1234567890 から拾う
    itemIdFrom: (html) => (html.match(/\/item\/(m\d{9,12})/) || [])[1] || '',
  },

  ヤフオク: {
    key: 'yahuoku',
    listUrls: [
      'https://auctions.yahoo.co.jp/closeduser/jp/show/mystatus?select=won',
      'https://auctions.yahoo.co.jp/closeduser/jp/show/mystatus?select=won&apg=2',
    ],
    linkSelector: 'a[href*="/jp/show/tradingnavi"], a[href*="contact.auctions.yahoo.co.jp"]',
    linkPattern: /tradingnavi|contact\.auctions/,
    loginCheck: (text) => !/ログイン|Yahoo! JAPAN ID/.test(text.slice(0, 2000)),
    // 取引ナビの URL・本文に aID=n1212071910 の形で入る
    itemIdFrom: (html) =>
      (html.match(/[?&]aID=([a-z]\d{8,12})/) || [])[1] ||
      (html.match(/\/auction\/([a-z]\d{8,12})/) || [])[1] ||
      '',
  },

  ヤフフリ: {
    key: 'paypayfleamarket',
    listUrls: ['https://paypayfleamarket.yahoo.co.jp/mypage/purchased'],
    linkSelector: 'a[href*="/item/"], a[href*="/trade/"]',
    linkPattern: /\/(item|trade)\//,
    loginCheck: (text) => !/ログイン|Yahoo! JAPAN ID/.test(text.slice(0, 2000)),
    itemIdFrom: (html) => (html.match(/\/item\/([a-z]\d{8,12})/) || [])[1] || '',
  },

  ラクマ: {
    key: 'rakuma',
    listUrls: ['https://fril.jp/mypage/transactions/buy'],
    linkSelector: 'a[href*="/transaction/"], a[href*="/item/"]',
    linkPattern: /\/(transaction|item)\//,
    loginCheck: (text) => !/ログイン|楽天会員/.test(text.slice(0, 2000)),
    itemIdFrom: (html) => (html.match(/fril\.jp\/item\/([a-z0-9]{8,})/) || [])[1] || '',
  },
};

export const SITE_NAMES = Object.keys(SITES);
