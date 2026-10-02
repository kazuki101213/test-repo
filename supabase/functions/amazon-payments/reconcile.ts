type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export type SaleCandidate = { sku: string; asin: string | null; soldOn: string; price: number; payout: number };
export type MatchResult = { sku: string; status: string; reason: string };
const yen = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Exact SKU, one physical unit, settled shipment only. Never allocate an order total. */
export function candidates(transaction: Obj, orderValue: unknown): { sales: SaleCandidate[]; results: MatchResult[] } {
  const sales: SaleCandidate[] = [], results: MatchResult[] = [];
  const skip = (sku: string, reason: string) => results.push({ sku, status: 'review', reason });
  if (transaction.transaction_type !== 'Shipment') {
    skip('—', '販売以外の取引（返金・調整等）のため、在庫の販売欄は変更しません。'); return { sales, results };
  }
  if (transaction.status !== 'RELEASED') {
    skip('—', '金額が保留中、または支払対象か確認できません。'); return { sales, results };
  }
  const order = obj(orderValue), date = order.createdTime;
  if (order.orderId !== transaction.order_id || obj(order.salesChannel).marketplaceId !== 'A1VC38T7YXB528'
      || typeof date !== 'string' || !Number.isFinite(Date.parse(date))) {
    skip('—', '注文ID・日本の注文・販売日を確認できません。'); return { sales, results };
  }
  const soldOn = new Date(Date.parse(date) + 9 * 3600000).toISOString().slice(0, 10);
  const payments = list(transaction.item_breakdowns).map(obj), orders = list(order.orderItems).map(obj);
  if (!payments.length) skip('—', '商品別のSKU・金額がありません。同じ期間を再取得してください。');
  for (const item of payments) {
    const sku = typeof item.sku === 'string' ? item.sku : '';
    if (!sku) { skip('—', 'Amazonの商品にSKUがありません。'); continue; }
    const matches = orders.filter(o => obj(o.product).sellerSku === sku);
    if (payments.filter(p => p.sku === sku).length !== 1 || matches.length !== 1) { skip(sku, '同じSKUが複数ある、または注文商品と一致しません。'); continue; }
    const match = matches[0], product = obj(match.product), unit = obj(obj(product.price).unitPrice);
    const price = typeof unit.amount === 'string' && /^\d+(\.0+)?$/.test(unit.amount) ? Number(unit.amount) : unit.amount;
    if (item.quantity !== 1 || match.quantityOrdered !== 1) { skip(sku, '販売数量が1個ではないため、個体への振り分けが必要です。'); continue; }
    if (item.asin && product.asin && item.asin !== product.asin) { skip(sku, '注文とペイメントのASINが一致しません。'); continue; }
    if (unit.currencyCode !== 'JPY' || item.currency !== 'JPY' || !yen(price) || !yen(item.amount)) {
      skip(sku, '商品別の販売価格・控除後金額が未確定、円以外、または整数の円額ではありません。'); continue;
    }
    sales.push({ sku, asin: typeof product.asin === 'string' ? product.asin : null, soldOn, price: price as number, payout: item.amount as number });
  }
  return { sales, results };
}
