export const expenseCategories = ['固定費', '変動費', '給与', '外注費', '諸経費'] as const;
export type ExpenseInput = {
  id: string; incurred_on: string; category: typeof expenseCategories[number]; name: string;
  amount: number; card_id: string | null; staff_id: string | null; memo: string | null;
};
export function validateExpense(input: ExpenseInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incurred_on) || !Number.isFinite(Date.parse(input.incurred_on)) || new Date(input.incurred_on).toISOString().slice(0, 10) !== input.incurred_on) throw new Error('経費の日付を選択してください。');
  if (!expenseCategories.includes(input.category)) throw new Error('経費の区分を選択してください。');
  if (!input.name.trim()) throw new Error('経費の内容を入力してください。');
  if (!Number.isSafeInteger(input.amount)) throw new Error('金額は整数で入力してください。');
}

export function monthlyExpenseDates(from: string, to: string, day: number): string[] {
  const validMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1900;
  if (!validMonth(from) || !validMonth(to) || from > to) throw new Error('開始月・終了月を正しい順序で選択してください。');
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('計上日は1〜31日で入力してください。');
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5)) - 1;
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5)) - 1;
  if (end - start >= 120) throw new Error('一度に登録できる期間は10年以内です。');
  return Array.from({ length: end - start + 1 }, (_, i) => {
    const year = Math.floor((start + i) / 12);
    const month = (start + i) % 12 + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  });
}
