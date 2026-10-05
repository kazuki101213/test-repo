import { useEffect, useState, type FormEvent } from 'react';
import type { DeliveryTask } from '@bussan/shared';
import { fetchProductMaker, saveDeliveryDescription } from '../api';
import { accessoryOptions, buildDescription, CONDITIONS_BY_TARGET, conditionForTarget, PRODUCT_TYPES, storedCondition, type DescriptionTarget } from '../description';

function initialTarget(task: DeliveryTask): DescriptionTarget {
  if (task.sales_channel === 'メルカリ' || task.description?.includes('商品名（メルカリ）')) return 'mercari';
  if (task.sales_channel === 'ヤフオク' || task.description?.includes('商品名（ヤフオク）')) return 'yahoo-auction';
  return 'amazon';
}

export default function DescriptionEditor({ task, onSaved }: { task: DeliveryTask; onSaved: () => Promise<void> }) {
  const [product, setProduct] = useState(task.description_template ?? (task.work_stream === 'テレビ' ? 'テレビ' : task.work_stream === 'ブルーレイ' ? 'ブルーレイレコーダー' : ''));
  const [target, setTarget] = useState<DescriptionTarget>(() => initialTarget(task));
  const [condition, setCondition] = useState(() => conditionForTarget(initialTarget(task), task.condition));
  const [accessories, setAccessories] = useState(task.accessories ?? '');
  const [year, setYear] = useState(task.manufacture_year?.toString() ?? '');
  const [manufacturer, setManufacturer] = useState('');
  const [manual, setManual] = useState<string | null>(task.description || null);
  const [saved, setSaved] = useState(Boolean(task.description));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchProductMaker(task.asin).then(value => { if (active) setManufacturer(value); })
      .catch(() => { if (active) setManufacturer(''); });
    return () => { active = false; };
  }, [task.asin]);

  const serial = task.sku.match(/^(\d+[a-z]*)-/i)?.[1]?.toLowerCase() || String(task.lot_seq);
  const generated = buildDescription({
    product, condition, accessories, year, target, salesChannel: task.sales_channel,
    inspected: task.inspected, cleaned: task.cleaned, sku: task.sku,
    itemNumber: serial, modelNo: task.model_no || task.title, manufacturer,
  });
  const description = manual ?? generated;
  const selected = accessories.split(/[、,\n]+/).map(value => value.trim()).filter(Boolean);
  const updateSelection = () => { setManual(null); setSaved(false); setNotice(''); };

  function toggleAccessory(value: string) {
    const next = selected.includes(value) ? selected.filter(entry => entry !== value) : [...selected, value];
    setAccessories(next.join('、')); updateSelection();
  }

  async function save(e: FormEvent) {
    e.preventDefault(); setError(''); setNotice('');
    if (!description.trim()) { setError('商品・コンディション・付属品を入力してください。'); return; }
    setBusy(true);
    try {
      await saveDeliveryDescription(task.id, {
        condition: storedCondition(target, condition), accessories, description,
        template: product || null, year: year ? Number(year) : null,
      });
      await onSaved(); setSaved(true); setNotice('保存しました。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <form className="card description-editor" onSubmit={e => void save(e)}>
    <h2>商品説明文</h2>
    <fieldset disabled={busy}>
      <div className="description-options">
        <label>販売先<select value={target} onChange={e => {
          const nextTarget = e.target.value as DescriptionTarget;
          setTarget(nextTarget);
          if (!CONDITIONS_BY_TARGET[nextTarget].includes(condition)) setCondition(conditionForTarget(nextTarget, storedCondition(target, condition)) || CONDITIONS_BY_TARGET[nextTarget][0] || '');
          updateSelection();
        }}><option value="amazon">Amazon</option><option value="mercari">メルカリ</option><option value="yahoo-auction">ヤフオク</option></select></label>
        <label>商品<select value={product} onChange={e => { setProduct(e.target.value); updateSelection(); }}><option value="">選択してください</option>{PRODUCT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>コンディション<select value={condition} onChange={e => { setCondition(e.target.value); updateSelection(); }}><option value="">選択してください</option>{CONDITIONS_BY_TARGET[target].map(value => <option key={value}>{value}</option>)}</select></label>
        {target !== 'amazon' && <label>メーカー<input value={manufacturer} onChange={e => { setManufacturer(e.target.value); updateSelection(); }} placeholder="商品リストから取得・必要に応じて修正" /></label>}
        {target === 'amazon' && <label>製造年（任意）<input type="number" min={1900} max={2100} step={1} value={year} onChange={e => { setYear(e.target.value); updateSelection(); }} placeholder="例：2020" /></label>}
      </div>
      {target === 'amazon' && <>
        <fieldset className="accessory-options"><legend>付属品</legend>{accessoryOptions(product).map(value => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => toggleAccessory(value)} />{value}</label>)}</fieldset>
        <label>付属品<textarea maxLength={2000} value={accessories} onChange={e => { setAccessories(e.target.value); updateSelection(); }} placeholder="手入力" /></label>
      </>}
      {description ? <label>商品名・説明文（自動生成）<textarea className="description-text" maxLength={10000} value={description} onChange={e => { setManual(e.target.value); setSaved(false); setNotice(''); }} /></label>
        : <p className="muted">販売先・商品・コンディションを選ぶと、商品名と説明文を生成します。</p>}
      {manual !== null && description && <div className="row"><span className="muted">手入力の文章を表示しています。</span><button type="button" className="btn" disabled={!generated} onClick={() => { setManual(null); setSaved(false); setNotice(''); }}>選択内容から再生成</button></div>}
      <button className="btn primary" type="submit">{busy ? '保存中…' : saved ? '上書き保存' : '説明文を保存'}</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}{error && <div className="error" role="alert">{error}</div>}
  </form>;
}
