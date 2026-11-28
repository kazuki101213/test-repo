// 価格巡回の決まり（2026-11-29 ユーザー指定）。外部と通信しない部分だけをここに置く。

export const MAX_GAP = 0.25;
const KEEPA_EPOCH_MINUTES = 21564000;
export const keepaMinutesToMs = (minutes: number) => (minutes + KEEPA_EPOCH_MINUTES) * 60000;

export type KeepaOffer = {
  condition?: number; isPrime?: boolean; lastSeen?: number; offerCSV?: number[];
};

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

/** 出品の最後の値段（本体＋送料）。値段が出ていない記録（-1）は飛ばす。 */
export function lastOfferPrice(csv: number[] | undefined): number | null {
  const c = csv ?? [];
  for (let i = c.length - 3; i >= 0; i -= 3) if (c[i + 1] > 0) return c[i + 1] + Math.max(0, c[i + 2]);
  return null;
}

/** 実績無し：Prime・ほぼ新品(2)/非常に良い(3)/良い(4)・最終確認60日以内の、最終確認が新しい5件の中央値 */
export function keepaMarketPrice(offers: KeepaOffer[], nowMs: number) {
  const from = nowMs - 60 * 86400000;
  const picked = offers
    .filter(o => o.isPrime && [2, 3, 4].includes(o.condition ?? 0) && o.lastSeen && keepaMinutesToMs(o.lastSeen) >= from)
    .map(o => ({ lastSeen: o.lastSeen!, price: lastOfferPrice(o.offerCSV) }))
    .filter((o): o is { lastSeen: number; price: number } => o.price !== null)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 5);
  return { price: median(picked.map(o => o.price)), prices: picked.map(o => o.price) };
}

export type AmazonOffer = {
  SubCondition?: string; IsFulfilledByAmazon?: boolean;
  ListingPrice?: { Amount?: number }; Shipping?: { Amount?: number };
};

/** 実績あり：今出ている中古「非常に良い」のFBA出品の最安値（本体＋送料） */
export function amazonMarketPrice(offers: AmazonOffer[]) {
  const prices = offers
    .filter(o => o.SubCondition === 'very_good' && o.IsFulfilledByAmazon === true && typeof o.ListingPrice?.Amount === 'number')
    .map(o => Math.round(o.ListingPrice!.Amount! + (o.Shipping?.Amount ?? 0)));
  return { price: prices.length ? Math.min(...prices) : null, count: prices.length };
}

/** 今の価格と比べて反映するか。差が25%以内なら上げ下げとも反映、超えたら反映しない。 */
export function decide(current: number, market: number | null) {
  if (market === null) return { apply: false, outcome: '相場なし' } as const;
  if (market === current) return { apply: false, outcome: '同じ価格' } as const;
  const gap = Math.abs(market - current) / current;
  if (gap > MAX_GAP) return { apply: false, outcome: '25%超の差（反映しない）', gap } as const;
  return { apply: true, outcome: market > current ? '値上げ' : '値下げ', gap } as const;
}

/** 管理アプリ・拡張機能と同じ決まり：利益率が入っていればそれ、空欄なら 23%（1万円以下）／20%（5万円以下）／17%。 */
export function targetCostFor(payout: number, profitRate: number | null): number {
  const rate = profitRate ?? (payout <= 10000 ? 23 : payout <= 50000 ? 20 : 17);
  return Math.round(payout * (100 - rate) / 100);
}

/** 仕入れ目標金額：今の値が決まりどおり（1円の差まで）なら新しい振込から計算し直し、手で入れた値は残す（毎日の照合と同じ）。 */
export function nextTarget(oldPayout: number | null, oldTarget: number | null, profitRate: number | null, newPayout: number) {
  const ruleTarget = oldPayout === null ? null : targetCostFor(oldPayout, profitRate);
  const manual = oldTarget !== null && ruleTarget !== null && Math.abs(oldTarget - ruleTarget) > 1;
  return manual ? oldTarget : targetCostFor(newPayout, profitRate);
}
