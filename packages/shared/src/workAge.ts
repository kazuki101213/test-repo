export function compareWorkStartedAt(left?: string | null, right?: string | null): number {
  const leftTime = Date.parse(left ?? '');
  const rightTime = Date.parse(right ?? '');
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
  if (!Number.isFinite(rightTime)) return -1;
  return leftTime - rightTime;
}
