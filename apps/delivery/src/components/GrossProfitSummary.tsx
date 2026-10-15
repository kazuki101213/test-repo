import { staffDisplayName, canViewDeliveryAssignee } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { getSupabase } from '@bussan/shared';
import type { Staff } from '@bussan/shared';
import { japanToday, monthlyGrossProfit, yen } from '../invoices';
import type { MonthlyGrossProfit } from '../invoices';

type Person = Pick<Staff, 'id' | 'name' | 'role'>;

export default function GrossProfitSummary({ staff }: { staff: Staff }) {
  const canSelectPurchaser = canViewDeliveryAssignee(staff);
  const [people, setPeople] = useState<Person[]>([]);
  const [purchaserId, setPurchaserId] = useState('');
  const [month, setMonth] = useState(japanToday().slice(0, 7));
  const [summary, setSummary] = useState<MonthlyGrossProfit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canSelectPurchaser) return;
    let active = true;
    void (async () => {
      try {
        const { data, error } = await getSupabase().from('staff').select('id,name,role').eq('is_active', true).in('role', ['admin', 'purchaser']).order('name');
        if (error) throw error;
        if (!active) return;
        const rows = (data ?? []) as Person[];
        setPeople(rows);
        setPurchaserId(current => current || rows[0]?.id || '');
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { active = false; };
  }, [canSelectPurchaser]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setSummary(null);
    const target = canSelectPurchaser ? purchaserId : staff.role === 'deliverer' ? null : staff.id;
    if (!month || (canSelectPurchaser && !target)) { setLoading(false); return; }
    void monthlyGrossProfit(target, month).then(data => { if (active) setSummary(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [staff.id, staff.role, canSelectPurchaser, purchaserId, month]);

  return <section className="card gross-profit-summary">
    <div className="toolbar"><h3>粗利益</h3><span style={{ flex: 1 }} />
      {canSelectPurchaser && <label>担当者<select value={purchaserId} onChange={event => setPurchaserId(event.target.value)}>
        {people.map(person => <option key={person.id} value={person.id}>{staffDisplayName(person)}</option>)}
      </select></label>}
      <label>対象月<input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p>読み込み中…</p> : !error && <>
      <div className="scroll"><table><thead><tr><th>販売日</th><th>SKU</th><th>仕入担当者</th><th>粗利益</th></tr></thead>
        <tbody>{summary?.rows.map(row => <tr key={`${row.sku}/${row.sold_on}`}><td>{row.sold_on}</td><td>{row.sku}</td><td>{staffDisplayName(row.purchaser_name) || '未設定'}</td><td>{yen(row.gross_profit)}</td></tr>)}</tbody>
        <tfoot><tr><th colSpan={3}>月間合計</th><th>{yen(summary?.total ?? 0)}</th></tr></tfoot>
      </table></div>
      {!summary?.rows.length && <p>対象月の販売実績はありません。</p>}
    </>}
  </section>;
}
