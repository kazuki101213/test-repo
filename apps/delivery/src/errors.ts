export function deliveryErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object') {
    const error = cause as { message?: unknown; details?: unknown; hint?: unknown };
    const parts = [error.message, error.details, error.hint]
      .filter((part): part is string => typeof part === 'string' && !!part.trim());
    if (parts.length) return [...new Set(parts)].join(' / ');
  }
  return typeof cause === 'string' && cause.trim() ? cause : '読み込みに失敗しました。再読み込みしてください。';
}
