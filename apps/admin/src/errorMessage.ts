/** Supabaseのエラーは Error ではない普通のオブジェクトなので、String() すると [object Object] になる。中の説明文を取り出す。 */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object') {
    const value = cause as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    // 57014：データベースが混んでいて8秒で打ち切られた（2026-11-27）
    if (value.code === '57014') return '混み合っていて読み込めませんでした。少し待ってから再読み込みしてください。';
    const parts = [value.message, value.details, value.hint]
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (parts.length) return parts.join(' ');
    if (typeof value.code === 'string') return `データ参照エラー (${value.code})`;
  }
  return String(cause);
}
