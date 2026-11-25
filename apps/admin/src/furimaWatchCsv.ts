import type { Product } from '@bussan/shared';

const excludedWords = '交換・修理用 リケーブル 付属品のみ';
const roundUpHundred = (amount: number) => Math.sign(amount) * Math.ceil(Math.abs(amount) / 100) * 100;
const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

type Variant = { cost: number; payout: number | null };

/**
 * フリマウォッチ用CSV。同じ番号（色違い・付属品や状態違いの通り）は型番ごとに1行にまとめる（2026-11-24 ユーザー指定）。
 * 上限は通りの中で一番高い仕入れ目標金額、pmin は一番安い仕入れ目標金額から出す。1通りしかない番号は今までと同じ文字。
 */
export function furimaWatchCsvRows(products: readonly Product[], stock: ReadonlyMap<string, number>) {
  const groups = new Map<string, Product[]>();
  for (const product of products) {
    // 2026-11-25：品番は管理者ごとの通し番号（色違いも別の番号）。同じ管理者・同じ型番を1行にまとめる。
    const model = product.model_no?.trim().replace(/\s+/g, ' ').toLowerCase();
    const key = model ? 'model:' + (product.owner_staff_id ?? '') + ':' + model : 'id:' + product.id;
    groups.set(key, [...(groups.get(key) ?? []), product]);
  }

  return [...groups.values()].flatMap(group => {
    const first = group[0]!;
    const model = group.map(product => product.model_no?.trim()).find(Boolean);
    const variants: Variant[] = group.flatMap(product => [
      ...(positive(product.target_cost) ? [{ cost: product.target_cost, payout: product.payout_estimate }] : []),
      ...(product.product_options ?? []).filter(option => option.is_active && positive(option.target_cost))
        .map(option => ({ cost: option.target_cost as number, payout: option.payout_estimate })),
    ]);
    if (!model || !variants.length || group.some(product => !product.asin.trim())) return [];

    const top = variants.reduce((best, variant) => variant.cost > best.cost ? variant : best);
    const lowest = Math.min(...variants.map(variant => variant.cost));
    const count = group.length + group.reduce((sum, product) => sum + (product.product_options ?? []).filter(option => option.is_active).length, 0);
    const held = group.reduce((sum, product) => sum + (stock.get(product.asin.trim().toUpperCase()) ?? 0), 0);
    const profit = top.payout === null ? '' : roundUpHundred(top.payout - top.cost);
    // 2026-11-25 ユーザー指定（全員）：1通りの番号は、メーカーの後に色・付属品や状態を書く（空欄なら今までどおり）。
    const head = (first.maker ?? '').trim().split(/\s+/)[0] ?? '';
    const maker = count > 1 ? head
      : first.color?.trim() || first.variant_label?.trim()
        ? [head, first.color?.trim(), first.variant_label?.trim()].filter(Boolean).join(' ')
        : first.maker ?? '';
    const number = group.length > 1 ? group.map(product => product.product_no ?? '').join('・') : (first.product_no ?? '') + (count > 1 ? '・' + count + '通り' : '');
    const name = [
      first.turnover ?? '', held, roundUpHundred(top.cost), model, maker,
      group.some(product => product.has_sold_before) ? '有' : '無',
    ].map(value => '【' + value + '】').join('') + '(' + profit + ')(' + number + ')';

    return [{
      name,
      switchAll: 'TRUE',
      kws: model,
      kwes: excludedWords,
      pmin: roundUpHundred(lowest / 2),
      pmax: roundUpHundred(top.cost * 11 / 10),
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
