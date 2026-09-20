export function yen(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `¥${value.toLocaleString('ja-JP')}`;
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function jpDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function daysLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  return `${days}日`;
}

/** 仕入からの経過日数を 高/中/低 回転に分類する（総合管理表と同じ区切り） */
export function turnoverBucket(days: number | null | undefined): '高' | '中' | '低' | null {
  if (days === null || days === undefined) return null;
  if (days <= 7) return '高';
  if (days <= 14) return '中';
  return '低';
}

export function profitRate(profit: number, sales: number | null | undefined): number | null {
  if (!sales) return null;
  return profit / sales;
}
