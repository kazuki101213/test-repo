import { useState, type FormEvent } from 'react';
import { CONDITIONS, type DeliveryTask, type ItemCondition } from '@bussan/shared';
import { saveDeliveryDescription } from '../api';
import { accessoryOptions, buildDescription, PRODUCT_TYPES } from '../description';

export default function DescriptionEditor({ task, onSaved }: { task: DeliveryTask; onSaved: () => Promise<void> }) {
  const [product, setProduct] = useState(task.description_template ?? (task.work_stream === 'テレビ' ? 'テレビ' : task.work_stream === 'ブルーレイ' ? 'ブルーレイレコーダー' : ''));
  const [condition, setCondition] = useState<ItemCondition | ''>(task.condition ?? '');
  const [accessories, setAccessories] = useState(task.accessories ?? '');
  const [year, setYear] = useState(task.manufacture_year?.toString() ?? '');
  const [manual, setManual] = useState<string | null>(task.description || null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generated = buildDescription({ product, condition, accessories, year, inspected: task.inspected, cleaned: task.cleaned, salesChannel: task.sales_channel });
  const description = manual ?? generated;
  const selected = accessories.split(/[、,\n]+/).map(value => value.trim()).filter(Boolean);
  function toggleAccessory(value: string) {
    const next = selected.includes(value) ? selected.filter(entry => entry !== value) : [...selected, value];
    setAccessories(next.join('、')); setManual(null); setNotice('');
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await saveDeliveryDescription(task.id, { condition: condition || null, accessories, description, template: product || null, year: year ? Number(year) : null });
      await onSaved(); setNotice('保存しました。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <form className="card description-editor" onSubmit={e => void save(e)}>
    <h2>商品説明文</h2>
    <fieldset disabled={busy}>
      <div className="description-options">
        <label>商品<select value={product} onChange={e => { setProduct(e.target.value); setManual(null); setNotice(''); }}><option value="">選択してください</option>{PRODUCT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>コンディション<select value={condition} onChange={e => { setCondition(e.target.value as ItemCondition); setManual(null); setNotice(''); }}><option value="">選択してください</option>{CONDITIONS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>製造年（任意）<input type="number" min={1900} max={2100} step={1} value={year} onChange={e => { setYear(e.target.value); setManual(null); setNotice(''); }} placeholder="例：2020" /></label>
      </div>
      <fieldset className="accessory-options"><legend>付属品</legend>{accessoryOptions(product).map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggleAccessory(value)} />{value}</label>)}</fieldset>
      <label>付属品の追記・編集<textarea maxLength={2000} value={accessories} onChange={e => { setAccessories(e.target.value); setManual(null); setNotice(''); }} placeholder="付属品を選択、または手入力" /></label>
      <label>説明文<textarea className="description-text" maxLength={10000} value={description} onChange={e => { setManual(e.target.value); setNotice(''); }} placeholder="商品・コンディション・付属品を選ぶと自動生成されます" /></label>
      {manual !== null && <div className="row"><span className="muted">保存済み・手入力の文章を表示しています。</span><button type="button" className="btn" disabled={!generated} onClick={() => { setManual(null); setNotice(''); }}>選択内容から再生成</button></div>}
      <button className="btn primary" type="submit">{busy ? '保存中…' : '説明文・商品情報を保存'}</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}{error && <div className="error" role="alert">{error}</div>}
  </form>;
}
