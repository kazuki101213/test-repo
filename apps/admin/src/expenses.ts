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
