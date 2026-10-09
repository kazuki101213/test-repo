/** Normalize user-entered search text while preserving partial-match behavior. */
export function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\s‐‑–—−ー]/g, '');
}
