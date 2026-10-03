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

export function productSerial(sku: string | null | undefined, lotSeq?: number): string {
  const match = sku?.match(/^([0-9]+[a-z]*)[-_]/i);
  return match?.[1]?.toLowerCase() ?? String(lotSeq ?? '');
}

export function normalizeSkuReturnSuffix(sku: string): string {
  return sku.replace(/^(\d+)([a-z]*)(?=[-_])/i, (_match, serial: string, suffix: string) => `${serial}${suffix.toLowerCase()}`);
}

export function productCount(rows: ReadonlyArray<{ lot_seq: number; sku?: string | null }>): number {
  return new Set(rows.map(row => productSerial(row.sku, row.lot_seq))).size;
}

export const inventoryRowHeight = 64;
export const inventoryHeaderHeight = 40;
export function inventoryWindow(total: number, scrollTop: number, height: number) {
  const start = Math.max(0, Math.floor((scrollTop - inventoryHeaderHeight) / inventoryRowHeight) - 8);
  const end = Math.min(total, start + Math.ceil(height / inventoryRowHeight) + 17);
  return { start, end, top: start * inventoryRowHeight, bottom: Math.max(0, total - end) * inventoryRowHeight };
}
