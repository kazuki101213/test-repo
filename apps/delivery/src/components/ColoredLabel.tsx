import { inventorySiteStyle } from '@bussan/shared';

// 仕入先・販売先は在庫と同じ背景色つきのラベルで出す（2026-11-24 ユーザー指定：旧来の文字前の色線は使わない）。
export default function ColoredLabel({ value }: { value: string | null | undefined }) {
  const text = value?.trim();
  if (!text || text === '—') return <>—</>;
  return <span className="inventory-label" style={inventorySiteStyle(text)}>{text}</span>;
}
