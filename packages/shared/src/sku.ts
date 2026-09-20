/**
 * 出品者SKU のルール
 *
 *   {通番号}-{仕入担当コード}{納品担当コード}-{購入日YYYYMMDD}-{仕入金額÷10}
 *   例) 2340-EEMM-20260916-1296
 *        通番 2340 / 石川秀樹(EE) が仕入れ / 株式会社吉光(MM) が納品 /
 *        2026-09-16 購入 / 仕入 ¥12,961
 *
 * 大元アプリと納品担当アプリはこの文字列だけで同じ商品を指せる。
 * 一度発番した SKU は Amazon 側にも登録されるため、後から変更してはいけない。
 */

export interface ParsedSku {
  lotSeq: string;
  purchaserCode: string;
  delivererCode: string;
  purchasedAt: string;   // YYYY-MM-DD
  /** SKU に埋まっている仕入金額（10円単位に丸められている） */
  costApprox: number;
}

const SKU_RE = /^([0-9]+[a-z]?)-([A-Z]{2})([A-Z]{2})-(\d{4})(\d{2})(\d{2})-(\d+)$/;

export function buildSku(input: {
  lotSeq: number | string;
  purchaserCode: string;
  delivererCode?: string | null;
  purchasedAt: string | Date;
  costAmount: number;
}): string {
  const d = typeof input.purchasedAt === 'string' ? new Date(input.purchasedAt) : input.purchasedAt;
  if (Number.isNaN(d.getTime())) throw new Error(`購入日が不正です: ${String(input.purchasedAt)}`);

  const ymd =
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');

  const deliverer = (input.delivererCode ?? 'ZZ').toUpperCase();
  // DB 側の app.build_sku と同じ切り捨てにそろえる
  const cost = Math.floor(input.costAmount / 10);

  return `${input.lotSeq}-${input.purchaserCode.toUpperCase()}${deliverer}-${ymd}-${cost}`;
}

export function parseSku(sku: string): ParsedSku | null {
  const m = SKU_RE.exec(sku.trim());
  if (!m) return null;
  const [, lotSeq, purchaserCode, delivererCode, y, mo, d, cost] = m as unknown as string[];
  return {
    lotSeq: lotSeq!,
    purchaserCode: purchaserCode!,
    delivererCode: delivererCode!,
    purchasedAt: `${y}-${mo}-${d}`,
    costApprox: Number(cost) * 10,
  };
}

export function isValidSku(sku: string): boolean {
  return SKU_RE.test(sku.trim());
}

/**
 * スキャナや手入力の揺れを吸収する。
 * 全角ハイフン・全角英数・前後の空白をならしてから判定する。
 */
export function normalizeSku(raw: string): string {
  return raw
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—―ー－]/g, '-')
    .replace(/\s+/g, '')
    .toUpperCase();
}
