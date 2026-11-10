import type { Product } from '@bussan/shared';

const excludedWords = '交換・修理用 リケーブル 付属品のみ';
const roundUpHundred = (amount: number) => Math.sign(amount) * Math.ceil(Math.abs(amount) / 100) * 100;

export function furimaWatchCsvRows(products: readonly Product[], stock: ReadonlyMap<string, number>) {
  return products.flatMap(product => {
    const asin = product.asin.trim().toUpperCase();
    const model = product.model_no?.trim();
    const cost = product.target_cost;
    if (!asin || !model || cost === null || !Number.isFinite(cost) || cost <= 0) return [];

    const held = stock.get(asin) ?? 0;
    const profit = product.payout_estimate === null ? '' : roundUpHundred(product.payout_estimate - cost);
    const name = [
      product.turnover ?? '', held, roundUpHundred(cost), model, product.maker ?? '',
      product.has_sold_before ? '有' : '無',
    ].map(value => '【' + value + '】').join('') + '(' + profit + ')(' + (product.product_no ?? '') + ')';

    return [{
      name,
      switchAll: 'TRUE',
      kws: model,
      kwes: excludedWords,
      pmin: roundUpHundred(cost / 2),
      pmax: roundUpHundred(cost * 11 / 10),
      sve: '',
      nickname: '',
      nicknameExs: '',
      itemStatuses: model === 'Aprica ラクリス' ? '1,2' : '1,2,3,4,5',
      freeShipping: '',
      kwsTitle: '',
      kwesTitle: excludedWords,
      autoBuy: 'FALSE',
      gotoBuy: 'FALSE',
      type: 'normal',
    }];
  });
}
