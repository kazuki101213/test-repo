// 商品リストの型番からメルカリの検索結果を開く（2026-11-22 ユーザー指定）。
export function mercariSearchUrl(modelNo: string): string {
  return 'https://jp.mercari.com/search?keyword=' + encodeURIComponent(modelNo.normalize('NFKC').replace(/\s+/g, ' ').trim());
}
