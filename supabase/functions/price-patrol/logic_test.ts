import { assertEquals } from 'jsr:@std/assert@1';
import { amazonMarketPrice, decide, keepaMarketPrice, keepaMinutesToMs, median, nextTarget } from './logic.ts';

const now = keepaMinutesToMs(8370000);
const daysAgo = (d: number) => 8370000 - d * 1440;
const offer = (condition: number, isPrime: boolean, lastSeenDays: number, price: number, ship = 0) =>
  ({ condition, isPrime, lastSeen: daysAgo(lastSeenDays), offerCSV: [daysAgo(200), price + 5000, 0, daysAgo(lastSeenDays + 1), price, ship] });

Deno.test('中央値（奇数・偶数）', () => {
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([26800, 27330, 27800, 28800]), 27565);
  assertEquals(median([]), null);
});

Deno.test('Keepa：Prime・ほぼ新品/非常に良い/良い・60日以内の、最終確認が新しい5件の中央値', () => {
  const offers = [
    offer(3, true, 1, 30000), offer(2, true, 2, 31000), offer(4, true, 3, 29000, 500),
    offer(3, true, 4, 28000), offer(3, true, 5, 27000), offer(3, true, 6, 10000), // 6件目は使わない
    offer(1, true, 0, 50000), // 新品は除く
    offer(5, true, 0, 5000), // 可は除く
    offer(3, false, 0, 5000), // Primeでない出品は除く
    offer(3, true, 61, 5000), // 60日より前は除く
  ];
  const result = keepaMarketPrice(offers, now);
  assertEquals(result.prices, [30000, 31000, 29500, 28000, 27000]);
  assertEquals(result.price, 29500);
});

Deno.test('Amazon：中古「非常に良い」のFBA出品だけの最安値（送料込み）', () => {
  const r = amazonMarketPrice([
    { SubCondition: 'very_good', IsFulfilledByAmazon: true, ListingPrice: { Amount: 30000 }, Shipping: { Amount: 0 } },
    { SubCondition: 'very_good', IsFulfilledByAmazon: true, ListingPrice: { Amount: 28000 }, Shipping: { Amount: 500 } },
    { SubCondition: 'very_good', IsFulfilledByAmazon: false, ListingPrice: { Amount: 20000 } },
    { SubCondition: 'good', IsFulfilledByAmazon: true, ListingPrice: { Amount: 19000 } },
  ]);
  assertEquals(r, { price: 28500, count: 2 });
  assertEquals(amazonMarketPrice([]).price, null);
});

Deno.test('25%以内なら上げ下げとも反映、超えたら反映しない', () => {
  assertEquals(decide(20000, 25000).apply, true);
  assertEquals(decide(20000, 25001).apply, false);
  assertEquals(decide(20000, 15000).apply, true);
  assertEquals(decide(20000, 14999).apply, false);
  assertEquals(decide(20000, 20000).apply, false);
  assertEquals(decide(20000, null).apply, false);
});

Deno.test('仕入れ目標：決まりどおりなら計算し直し、手入力は残す', () => {
  assertEquals(nextTarget(20000, 16000, null, 22000), 17600);
  assertEquals(nextTarget(20000, 15000, null, 22000), 15000);
  assertEquals(nextTarget(20000, 14000, 30, 22000), 15400);
});
