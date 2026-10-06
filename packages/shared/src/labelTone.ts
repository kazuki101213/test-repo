const LABEL_TONES: Record<string, string> = {
  ヤフオク: 'orange', メルカリ: 'red', ヤフフリ: 'yellow', ラクマ: 'purple',
  FBA: 'blue', 自己発送: 'green', 新品: 'green',
  ほぼ新品: 'blue', 非常に良い: 'red', 良い: 'yellow', 可: 'gray',
};

export function labelTone(value: string): string | undefined {
  return LABEL_TONES[value];
}
