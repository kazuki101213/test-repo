import { useEffect, useState, type FormEvent } from 'react';
import type { DeliveryTask } from '@bussan/shared';
import { fetchProductMaker, saveDeliveryDescription } from '../api';
import { accessoryOptions, buildDescription, CONDITIONS_BY_TARGET, conditionForTarget, PRODUCT_TYPES, storedCondition, type DescriptionTarget } from '../description';

function initialTarget(task: DeliveryTask): DescriptionTarget {
  if (task.sales_channel === 'メルカリ' || task.description?.includes('商品名（メルカリ）')) return 'mercari';
  if (task.sales_channel === 'ヤフオク' || task.description?.includes('商品名（ヤフオク）')) return 'yahoo-auction';
  return 'amazon';
}

function splitMarketplaceListing(value: string): { title: string; body: string } {
  const match = value.match(/^商品名（(?:メルカリ|ヤフオク)）\r?\n([\s\S]*?)\r?\n\r?\n説明文\r?\n([\s\S]*)$/);
  return match ? { title: match[1] ?? '', body: match[2] ?? '' } : { title: '', body: value };
}

function joinMarketplaceListing(target: DescriptionTarget, title: string, body: string): string {
  const marketplace = target === 'mercari' ? 'メルカリ' : 'ヤフオク';
  return `商品名（${marketplace}）\n${title}\n\n説明文\n${body}`;
}

function CopyIconButton({ label, copied, disabled, onClick, className = '' }: {
  label: string; copied: boolean; disabled: boolean; onClick: () => void; className?: string;
}) {
  return <button type="button" className={`copy-icon-button ${className}`} aria-label={`${label}をコピー`} title={copied ? 'コピーしました' : `${label}をコピー`}
    disabled={disabled} onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {copied
        ? <path d="m5 12 4 4L19 6" />
        : <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" /></>}
    </svg>
  </button>;
}

export default function DescriptionEditor({ task, listingSkus, onSaved }: { task: DeliveryTask; listingSkus: string[]; onSaved: () => Promise<void> }) {
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
  const [copiedField, setCopiedField] = useState<'title' | 'body' | null>(null);

  useEffect(() => {
    let active = true;
    void fetchProductMaker(task.asin).then(value => { if (active) setManufacturer(value); })
      .catch(() => { if (active) setManufacturer(''); });
    return () => { active = false; };
  }, [task.asin]);

  const serial = task.sku.match(/^(\d+[a-z]*)-/i)?.[1]?.toLowerCase() || String(task.lot_seq);
  const generated = buildDescription({
    product, condition, accessories, year, target, salesChannel: task.sales_channel,
    inspected: task.inspected, cleaned: task.cleaned, sku: task.sku, listingSkus,
    itemNumber: serial, modelNo: task.model_no || task.title, manufacturer,
  });
  const description = manual ?? generated;
  const generatedListing = splitMarketplaceListing(generated);
  const listing = splitMarketplaceListing(description);
  const listingTitle = listing.title || generatedListing.title;
  const selected = accessories.split(/[、,\n]+/).map(value => value.trim()).filter(Boolean);
  const updateSelection = () => { setManual(null); setSaved(false); setNotice(''); };

  function updateListing(title: string, body: string) {
    setManual(joinMarketplaceListing(target, title, body)); setSaved(false); setNotice('');
  }

  async function copyField(field: 'title' | 'body', value: string) {
    if (!value.trim()) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch { /* Use the fallback for browsers without clipboard permission. */ }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand('copy');
      textarea.remove();
    }
    if (copied) {
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(current => current === field ? null : current), 1600);
    } else setError('コピーできませんでした。ブラウザーの権限を確認してください。');
  }

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
      {target !== 'amazon' && description ? <div className="marketplace-listing-fields">
        <label><span className="marketplace-listing-heading">商品名<CopyIconButton label="商品名" copied={copiedField === 'title'} disabled={!listingTitle.trim()} onClick={() => void copyField('title', listingTitle)} /></span>
          <textarea className="marketplace-title-text" rows={2} maxLength={500} value={listingTitle} onChange={e => updateListing(e.target.value, listing.body)} /></label>
        <label><span className="marketplace-listing-heading">説明文<CopyIconButton label="説明文" copied={copiedField === 'body'} disabled={!listing.body.trim()} onClick={() => void copyField('body', listing.body)} /></span>
          <textarea className="description-text marketplace-body-text" maxLength={10000} value={listing.body} onChange={e => updateListing(listingTitle, e.target.value)} /></label>
      </div> : description ? <label>商品名・説明文（自動生成）<textarea className="description-text" maxLength={10000} value={description} onChange={e => { setManual(e.target.value); setSaved(false); setNotice(''); }} /></label>
        : <p className="muted">販売先・商品・コンディションを選ぶと、商品名と説明文を生成します。</p>}
      {manual !== null && description && <div className="row"><span className="muted">手入力の文章を表示しています。</span><button type="button" className="btn" disabled={!generated} onClick={() => { setManual(null); setSaved(false); setNotice(''); }}>選択内容から再生成</button></div>}
      <button className="btn primary" type="submit">{busy ? '保存中…' : saved ? '上書き保存' : '説明文を保存'}</button>
    </fieldset>
    {notice && <p role="status">{notice}</p>}{error && <div className="error" role="alert">{error}</div>}
  </form>;
}

