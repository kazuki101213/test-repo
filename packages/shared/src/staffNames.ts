import type { Staff } from './types';
export const STAFF_DISPLAY_NAMES: Record<string, string> = {
  AA: 'AA 長部 一輝', DD: 'DD 久保田 ゆかり', EE: 'EE 石川 秀櫢', HH: 'HH 新川 水紀',
  II: 'II 久保田 真由', KK: 'KK 株式会社 コエル', LL: 'LL 土井 花菜', MM: 'MM 株式会社吉光',
};
const labelsByName = new Map([
  ['長部一輝', STAFF_DISPLAY_NAMES.AA], ['久保田ゆかり', STAFF_DISPLAY_NAMES.DD],
  ['石川秀樹', STAFF_DISPLAY_NAMES.EE], ['石川秀櫢', STAFF_DISPLAY_NAMES.EE],
  ['新川水紀', STAFF_DISPLAY_NAMES.HH], ['久保田真由', STAFF_DISPLAY_NAMES.II],
  ['株式会社コエル', STAFF_DISPLAY_NAMES.KK], ['土井花菜', STAFF_DISPLAY_NAMES.LL],
  ['株式会社吉光', STAFF_DISPLAY_NAMES.MM],
]);
export const DELIVERY_STAFF_CODES = ['AA', 'DD', 'EE', 'HH', 'II', 'KK', 'LL', 'MM'] as const;
/** One ordered list for delivery assignee selectors in both apps. */
export function deliveryStaffOptions<T extends { name: string; code?: string; is_active?: boolean }>(rows: T[]): T[] {
  const codeOf = (row: T) => row.code || DELIVERY_STAFF_CODES.find(code => STAFF_DISPLAY_NAMES[code] === staffDisplayName(row.name));
  return DELIVERY_STAFF_CODES.flatMap(code => rows.filter(row => row.is_active !== false && codeOf(row) === code));
}
/** Format labels without changing identity fields or saved business names. */
export function staffDisplayName(value: string | Pick<Staff, 'name'> & Partial<Pick<Staff, 'code' | 'display_name'>> | null | undefined): string {
  if (!value) return '';
  if (typeof value !== 'string') return (value.code && STAFF_DISPLAY_NAMES[value.code]) || value.display_name || staffDisplayName(value.name);
  return labelsByName.get(value.replace(/\s/g, '')) || value;
}
export function canViewDeliveryAssignee(staff: Pick<Staff, 'code' | 'role'>): boolean {
  return staff.code === 'AA' && staff.role === 'admin';
}
