/** A product title remains a legacy fallback, but an Amazon-return FNSKU is never a model. */
export function productModelText(item: { model_no: string | null; title: string; marketplace: string }): string {
  return item.model_no?.trim() || (item.marketplace === '動作品Amazon返品' ? '型番未登録' : item.title.trim() || '—');
}
