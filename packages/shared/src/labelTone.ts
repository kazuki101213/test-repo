import { MARKETPLACES, SALES_CHANNELS } from './constants';

const SITE_LABELS = new Set<string>([...MARKETPLACES, ...SALES_CHANNELS]);
const LABEL_TONES: Record<string, string> = {
  ヤフオク: 'orange', メルカリ: 'red', ヤフフリ: 'yellow', ラクマ: 'purple',
  FBA: 'blue', 自己発送: 'green', 新品: 'green',
  ほぼ新品: 'blue', 非常に良い: 'red', 良い: 'yellow', 可: 'gray',
};

export function labelTone(value: string): string | undefined {
  return LABEL_TONES[value.trim()];
}

/** Site fields use the native input without a decorative colored line. */
export function selectLabelTone(value: string): string | undefined {
  return SITE_LABELS.has(value.trim()) ? undefined : labelTone(value);
}
