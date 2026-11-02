/** Pack measured rows, reserving the footer only on the final page. */
export function invoicePageEnds(heights: number[], first: number, continuation: number, footer: number): number[] {
  const ends: number[] = [];
  let start = 0;
  while (start < heights.length) {
    const capacity = Math.max(1, ends.length ? continuation : first);
    const remaining = heights.slice(start).reduce((sum, height) => sum + height, 0);
    if (remaining + footer <= capacity) { ends.push(heights.length); break; }
    let used = 0, end = start;
    while (end < heights.length && (end === start || used + heights[end]! <= capacity)) {
      // Keep a row with the footer rather than creating an empty final page.
      if (end === heights.length - 1 && end > start) break;
      used += heights[end]!; end++;
    }
    ends.push(end); start = end;
  }
  return ends.length ? ends : [0];
}
