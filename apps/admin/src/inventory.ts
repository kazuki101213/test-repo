/** Fetch in transport batches without imposing a display limit. */
export async function readAllRows<T extends { id: string }>(
  read: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const rows = new Map<string, T>();
  for (let offset = 0; ; offset += 500) {
    const batch = await read(offset, offset + 499);
    for (const row of batch) rows.set(row.id, row);
    if (batch.length < 500) return [...rows.values()];
  }
}

export function productCount(rows: ReadonlyArray<{ lot_seq: number }>): number {
  return new Set(rows.map(row => row.lot_seq)).size;
}

export const inventoryRowHeight = 88;
export const inventoryHeaderHeight = 40;
export function inventoryWindow(total: number, scrollTop: number, height: number) {
  const start = Math.max(0, Math.floor((scrollTop - inventoryHeaderHeight) / inventoryRowHeight) - 8);
  const end = Math.min(total, start + Math.ceil(height / inventoryRowHeight) + 17);
  return { start, end, top: start * inventoryRowHeight, bottom: Math.max(0, total - end) * inventoryRowHeight };
}
