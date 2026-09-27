import { validateExpense, type ExpenseInput } from '../src/expenses.ts';
const expense: ExpenseInput = { id: 'test', incurred_on: '2026-09-27', category: '諸経費', name: '梱包資材', amount: 1000, card_id: null, staff_id: null, memo: null };
Deno.test('valid expense and zero amount are accepted', () => {
  validateExpense(expense); validateExpense({ ...expense, amount: 0 });
});
for (const patch of [{ incurred_on: '' }, { incurred_on: '2026-02-30' }, { name: '  ' }, { amount: -1 }, { amount: 1.5 }, { amount: NaN }, { amount: Infinity }, { amount: Number.MAX_SAFE_INTEGER + 1 }]) {
  Deno.test(`invalid expense rejected: ${JSON.stringify(patch)}`, () => {
    let rejected = false;
    try { validateExpense({ ...expense, ...patch }); } catch { rejected = true; }
    if (!rejected) throw new Error('invalid input accepted');
  });
}
