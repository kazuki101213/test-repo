import { canViewDeliveryAssignee, spareSearchFields, matchesSpareSearch, type SpareSearchField } from '@bussan/shared';
import { staffDisplayName } from '@bussan/shared';
import { useEffect, useState } from 'react';
import { fetchSpareAccessories, spareState, yen } from '@bussan/shared';
import type { SpareAccessory, Staff } from '@bussan/shared';
import { fetchSpareOwners } from '../api';

export default function Spares({ staff }: { staff: Staff }) {
  const [rows, setRows] = useState<SpareAccessory[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [queryField, setQueryField] = useState<SpareSearchField>('title');
  const canSearchOwner = canViewDeliveryAssignee(staff);
  const [spareOwners, setSpareOwners] = useState<{ id: string; name: string }[]>([]);
  const [delivererId, setDelivererId] = useState('');

  useEffect(() => {
    if (!canSearchOwner) return;
    let active = true;
    fetchSpareOwners()
      .then(data => { if (active) setSpareOwners(data); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [canSearchOwner]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await fetchSpareAccessories(staff.role === 'admin' ? undefined : staff.id);
        if (active) { setRows(data); setError(''); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { fetching = false; if (active) setLoading(false); }
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const timer = window.setInterval(visible, 30000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [staff.id, staff.role]);

  const selectedOwner = spareOwners.find(owner => owner.id === delivererId);
  const shown = rows.filter(row => !row.used_for_item_id && matchesSpareSearch(row, queryField, query, delivererId, selectedOwner?.name));
  return <section className="card">
    <h2>予備</h2>
    {!canSearchOwner && <p className="muted staff-scope">担当者：{staffDisplayName(staff)}</p>}
    <div className="spare-search" role="group" aria-label="予備検索">
      <select aria-label="予備の検索項目" value={queryField} onChange={event => { setQueryField(event.target.value as SpareSearchField); setQuery(''); setDelivererId(''); }}>
        {spareSearchFields.filter(field => canSearchOwner || field.value !== 'owner').map(field => <option key={field.value} value={field.value}>{field.label}</option>)}
      </select>
      {queryField === 'owner' && canSearchOwner
        ? <select aria-label="保管担当者で検索" value={delivererId} onChange={event => setDelivererId(event.target.value)}><option value="">全員</option>{spareOwners.map(owner => <option key={owner.id} value={owner.id}>{staffDisplayName(owner)}</option>)}</select>
        : <input type="search" aria-label="予備を検索" placeholder="検索" value={query} onChange={event => setQuery(event.target.value)} />}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p>読み込み中…</p> : shown.length === 0 ? <p className="empty">予備はありません。</p> :
      <div className="spare-list">{shown.map(row => <div className="spare-row" key={row.id}>
        <div className="spare-row-heading"><div><strong>{row.title}</strong> <span className="badge">{spareState(row)}</span></div></div>
        <div>保管担当者：{staffDisplayName(row.owner_name) || '未設定'}</div>
        <div>購入日：{row.purchased_at || '—'}　仕入金額：{yen(row.cost_amount)}</div>
        {row.source_sku && <div>SKU：{row.source_sku}</div>}
        {row.marketplace_item_id && <div>商品ID：{row.marketplace_item_id}</div>}
        {row.tracking_no && <div>追跡番号：{row.tracking_no}</div>}
        {row.usage_note && <div>利用記録：{row.usage_note}</div>}
      </div>)}</div>}
  </section>;
}
