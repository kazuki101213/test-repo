import type { CSSProperties } from 'react';

// Full-width Japanese characters need about twice the space of a digit.
// Keep empty fields usable and constrain long URLs/SKUs to their grid cell.
export function entryWidth(value: unknown, minimum = 12): CSSProperties {
  const characters = Array.from(String(value ?? '')).reduce(
    (width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0,
  );
  return { width: `calc(${Math.max(minimum, characters)}ch + 2.5rem)`, maxWidth: '100%', boxSizing: 'border-box' };
}
