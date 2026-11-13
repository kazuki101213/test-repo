// 総合管理表の「商品リスト」と同じジャンル別の振込率。
const payoutRates = new Map<string, number>([
  ['家電＆カメラ', 85],
  ['ホーム&キッチン', 85],
  ['DIY・工具・ガーデン', 85],
  ['文房具・オフィス用品', 85],
  ['ゲーム用アクセサリー', 85],
  ['ペット用品', 85],
  ['ベビー用品・マタニティ', 85],
  ['ビューティー', 90],
  ['ホビー', 90],
  ['おもちゃ', 90],
  ['楽器・音響機器', 90],
  ['スポーツ&アウトドア', 90],
  ['車&バイク', 90],
  ['パソコン・周辺機器', 92],
  ['ゲーム本体', 92],
  ['産業・研究開発用品', 92],
]);

export const PRODUCT_GENRES = [...payoutRates.keys()];
export const PRODUCT_TURNOVER = ['高', '中', '低'];
export const PRODUCT_SHIPPING_CATEGORIES = [
  { value: 'モ', label: 'モニター（モ）', defaultSize: '140' },
  { value: 'ブ', label: 'ブルーレイレコーダー（ブ）', defaultSize: '100' },
  { value: '小', label: '小物（小）', defaultSize: '' },
];
export const PRODUCT_SHIPPING_SIZES = [
  '60', '80', '100', '120', '140', '160', '180', '200', 'ネコポス',
  '宅急便コンパクト', 'ゆうパケットプラス', 'ゆうパケットポストmini', 'ゆうパケットポスト', 'ゆうパケット',
];

export function estimateProductAmounts(genre: string, price: number | null) {
  const rate = payoutRates.get(genre);
  if (rate === undefined || price === null || !Number.isSafeInteger(price) || price < 0) {
    return { payout_estimate: null, target_cost: null };
  }

  // Choose the target bracket before rounding the payout to whole yen.
  const payoutHundredths = BigInt(price) * BigInt(rate);
  const targetRate = payoutHundredths <= 1_000_000n ? 55n : payoutHundredths <= 1_500_000n ? 75n : 76n;
  return {
    payout_estimate: Number((payoutHundredths + 50n) / 100n),
    target_cost: Number((payoutHundredths * targetRate + 5000n) / 10000n),
  };
}
