/** A product title remains a legacy fallback, but an Amazon-return FNSKU is never a model. */
export function productModelText(item: { model_no: string | null; title: string; marketplace: string }): string {
  return item.model_no?.trim() || (item.marketplace === '動作品Amazon返品' ? '未登録' : item.title.trim() || '—');
}

/** Listing titles may use a real product name even when the catalog model is missing. */
export function productListingName(item: { model_no: string | null; title: string; marketplace: string }): string {
  if (item.model_no?.trim()) return item.model_no.trim();
  const title = item.title.trim();
  return /^(?:X[0-9A-Z]{9}|未登録|型番未登録|—)$/i.test(title) ? "" : title;
}
