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
