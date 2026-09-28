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
  const [showDescription, setShowDescription] = useState(false);
  const generated = buildDescription({ product, condition, accessories, year, inspected: task.inspected, cleaned: task.cleaned, salesChannel: task.sales_channel });
  const description = manual ?? generated;
  const selected = accessories.split(/[、,\n]+/).map(value => value.trim()).filter(Boolean);
  function toggleAccessory(value: string) {
    const next = selected.includes(value) ? selected.filter(entry => entry !== value) : [...selected, value];
    setAccessories(next.join('、')); setManual(null); setShowDescription(false); setNotice('');
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setError(''); setNotice('');
    if (!description.trim()) { setError('商品・コンディション・付属品を入力してください。'); return; }
    setShowDescription(true); setBusy(true);
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
        <label>商品<select value={product} onChange={e => { setProduct(e.target.value); setManual(null); setShowDescription(false); setNotice(''); }}><option value="">選択してください</option>{PRODUCT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>コンディション<select value={condition} onChange={e => { setCondition(e.target.value as ItemCondition); setManual(null); setShowDescription(false); setNotice(''); }}><option value="">選択してください</option>{CONDITIONS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>製造年（任意）<input type="number" min={1900} max={2100} step={1} value={year} onChange={e => { setYear(e.target.value); setManual(null); setShowDescription(false); setNotice(''); }} placeholder="例：2020" /></label>
      </div>
      <fieldset className="accessory-options"><legend>付属品</legend>{accessoryOptions(product).map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggleAccessory(value)} />{value}</label>)}</fieldset>
      <label>付属品<textarea maxLength={2000} value={accessories} onChange={e => { setAccessories(e.target.value); setManual(null); setShowDescription(false); setNotice(''); }} placeholder="手入力" /></label>
      {showDescription && description ? <label>説明文(自動生成)<textarea className="description-text" maxLength={10000} value={description} onChange={e => { setManual(e.target.value); setNotice(''); }} /></label>
        : <p className="muted">商品・コンディション・付属品を選ぶと説明文を表示します。</p>}
      {showDescription && manual !== null && <div className="row"><span className="muted">保存済み・手入力の文章を表示しています。</span><button type="button" className="btn" disabled={!generated} onClick={() => { setManual(null); setNotice(''); }}>選択内容から再生成</button></div>}
      <button className="btn primary" type="submit">{busy ? '表示中…' : '説明文を表示'}</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}{error && <div className="error" role="alert">{error}</div>}
  </form>;
}
