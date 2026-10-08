/** The dashboard and details both use Japan calendar dates. */
export function workloadPeriod(now = new Date()) {
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)), day = Number(today.slice(8, 10));
  const start = new Date(Date.UTC(year, month - 4, 1));
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return { today, monthStart: today.slice(0, 7) + '-01', averageStart: start.toISOString().slice(0, 10) };
}
