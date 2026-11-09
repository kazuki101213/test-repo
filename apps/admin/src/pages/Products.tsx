import { useEffect, useRef, useState } from 'react';
import { staffDisplayName, yen } from '@bussan/shared';
import type { Product, Staff } from '@bussan/shared';
import { createProduct, deleteProducts, fetchProductCatalogOwners, fetchProductSaleHistory, fetchProductSaleSummaries, type ProductCatalogOwner, type ProductSaleSummary, fetchProducts, updateProductField, updateProductDetails, updateProductShippingSettings, type ProductDetailsInput, type ProductField, type ProductRegistrationInput, type ProductSaleHistory } from '../api';
import { downloadCsv } from '../csv';
import { estimateProductAmounts, PRODUCT_GENRES, PRODUCT_SHIPPING_CATEGORIES, PRODUCT_SHIPPING_SIZES, PRODUCT_TURNOVER } from '../productEstimates';
import ColoredLabel from '../components/ColoredLabel';
import { useTaskConfirmation } from '../components/TaskConfirmation';
import '../components/ExpenseSelection.css';
import './ProductSelection.css';

const emptyProduct: ProductRegistrationInput = {
  asin: '', model_no: '', maker: '', genre: '', turnover: '', list_price: '',
  shipping_category: '', shipping_size: '',
};
const shippingSizeLabel = (size: string) => /^\d+$/.test(size) ? `${size}サイズ` : size;

export default function Products({ me }: { me: Staff }) {
  const confirmation = useTaskConfirmation();
  const [rows, setRows] = useState<Product[]>([]);
  const [salesByProduct, setSalesByProduct] = useState<Record<string, ProductSaleHistory[]>>({});
  const [summaries,setSummaries]=useState<Record<string,ProductSaleSummary>>({});
  const [historyLoading,setHistoryLoading]=useState(false);
  const [historyError,setHistoryError]=useState('');
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [query, setQuery] = useState('');
  const [owners, setOwners] = useState<ProductCatalogOwner[]>([me]);
  const [ownerFilter, setOwnerFilter] = useState(me.id);
  const [ownerError, setOwnerError] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [newProduct, setNewProduct] = useState(emptyProduct);
  const [editing, setEditing] = useState<{ product: Product; field: ProductField; value: string } | null>(null);
  const [fullEditProduct, setFullEditProduct] = useState<Product | null>(null);
  const [fullEditDraft, setFullEditDraft] = useState<ProductDetailsInput | null>(null);
  const [sizeEditProduct, setSizeEditProduct] = useState<Product | null>(null);
  const [sizeEditDraft, setSizeEditDraft] = useState<{ shipping_category: string; shipping_size: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const deleteLock = useRef(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    void fetchProductCatalogOwners().then(result => {
      if (active) setOwners(result);
    }).catch(() => {
      if (active) setOwnerError('管理者一覧を読み込めませんでした。画面を再読み込みしてください。');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const id = setTimeout(() => {
      fetchProducts(query || undefined, ownerFilter || undefined)
        .then(async products => {
          if (cancelled) return;
          setRows(products);
          const summaries = await fetchProductSaleSummaries(products);
          if (cancelled) return;
          setSummaries(Object.fromEntries(summaries.map(row=>[row.product_id,row])));
          setError(null);
        })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [query, ownerFilter, revision]);

  useEffect(()=>{
    if(!historyProduct)return;
    let active=true;setHistoryLoading(true);setHistoryError('');
    void fetchProductSaleHistory([historyProduct]).then(rows=>{
      if(active)setSalesByProduct({[historyProduct.id]:rows.sort((a,b)=>b.sold_on.localeCompare(a.sold_on)||a.id.localeCompare(b.id))});
    }).catch(e=>{if(active)setHistoryError(e instanceof Error?e.message:String(e));})
      .finally(()=>{if(active)setHistoryLoading(false);});
    return()=>{active=false;};
  },[historyProduct,revision]);

  async function saveEdit() {
    if (!editing) return;
    setBusy(true); setError(null);
    try { await updateProductField(editing.product, editing.field, editing.value); setEditing(null); setRevision(n => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function addProduct() {
    setBusy(true); setError(null);
    try {
      await createProduct(newProduct);
      setNewProduct(emptyProduct);
      if (ownerFilter && ownerFilter !== me.id) showOwner(me.id);
      setRevision(n => n + 1);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function startFullEdit(product: Product) {
    setError(null);
    setFullEditProduct(product);
    setFullEditDraft({
      product_no: String(product.product_no ?? ''), asin: product.asin, model_no: product.model_no ?? '', maker: product.maker ?? '', genre: product.genre ?? '',
      turnover: product.turnover ?? '', shipping_category: product.shipping_category ?? '', shipping_size: product.shipping_size ?? '',
      list_price: String(product.list_price ?? ''), payout_estimate: String(product.payout_estimate ?? ''), target_cost: String(product.target_cost ?? ''),
      has_sold_before: String(product.has_sold_before),
    });
  }

  async function saveFullEdit() {
    if (!fullEditProduct || !fullEditDraft) return;
    setBusy(true); setError(null);
    try { await updateProductDetails(fullEditProduct, fullEditDraft); setFullEditProduct(null); setFullEditDraft(null); setRevision(n => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function startSizeEdit(product: Product) {
    setError(null);
    setSizeEditProduct(product);
    setSizeEditDraft({ shipping_category: product.shipping_category ?? '', shipping_size: product.shipping_size ?? '' });
  }

  async function saveSizeEdit() {
    if (!sizeEditProduct || !sizeEditDraft) return;
    setBusy(true); setError(null);
    try { await updateProductShippingSettings(sizeEditProduct, sizeEditDraft); setSizeEditProduct(null); setSizeEditDraft(null); setRevision(n => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function showOwner(id: string) {
    setLoading(true);
    setRows([]);
    setSelected(new Set());
    setError(null);
    setMessage('');
    setOwnerFilter(id);
  }

  const ownerNames = new Map(owners.map(owner => [owner.id, staffDisplayName(owner)]));
  const ownerOption = (owner: ProductCatalogOwner) => <option key={owner.id} value={owner.id}>{ownerNames.get(owner.id)}</option>;
  const selectedRows = rows.filter(row => selected.has(row.id));
  const newProductEstimates = estimateProductAmounts(newProduct.genre, newProduct.list_price ? Number(newProduct.list_price) : null);
  function askDelete() {
    if (!selectedRows.length || loading || busy || deleting) return;
    let remaining = selectedRows.map(row => row.id);
    confirmation.ask(`商品リスト ${remaining.length}件の削除：${selectedRows.map(row => `${row.model_no || row.asin}（${row.asin}）`).join('、')}`, async () => {
      if (deleteLock.current) return;
      deleteLock.current = true; setDeleting(true); setError(null); setMessage('');
      try {
        const deleted = new Set(await deleteProducts(remaining));
        setRows(current => current.filter(row => !deleted.has(row.id)));
        setSelected(current => new Set([...current].filter(id => !deleted.has(id))));
        remaining = remaining.filter(id => !deleted.has(id));
        setRevision(n => n + 1);
        if (remaining.length) throw new Error(`${remaining.length}件は削除できません。すでに削除済みか、削除権限がありません。`);
        setMessage('選択した商品を商品リストから削除しました。');
      } finally { deleteLock.current = false; setDeleting(false); }
    }, '登録済みの在庫・販売履歴は残ります。');
  }

  const fieldLabels: Record<ProductField, string> = {
    product_no: '品番', asin: 'ASIN', model_no: '型番', maker: 'メーカー', genre: 'ジャンル',
    turnover: '回転', list_price: '販売想定金額', payout_estimate: '振込想定金額', target_cost: '仕入れ目標金額',
    has_sold_before: '実績',
  };
  const startEdit = (product: Product, field: ProductField) => setEditing({ product, field, value: String(product[field] ?? '') });
  const cell = (product: Product, field: ProductField, label: string) => <button className="inventory-cell-edit" onClick={() => startEdit(product, field)}>{label}</button>;
  const recentAmazonAverage = (productId: string) => {
    const summary=summaries[productId];
    return summary?.amazon_count && summary.amazon_average!==null ? {amount:summary.amazon_average,count:summary.amazon_count}:null;
  };

  return (
    <>
      {confirmation.confirmation}
      <div className="dashboard-workspace with-expense product-workspace registration-workspace"><section className="card dashboard-content product-list">
      <p className="sub">総合管理表の「商品リスト」。仕入れ目標金額を下回る値段で買えるかの判断に使います。</p>

      <div className="toolbar product-search-toolbar">
        <select aria-label="商品リストの表示対象" value={ownerFilter} disabled={busy || deleting || confirmation.pending} onChange={event => showOwner(event.target.value)}>
          <option value="">全員</option>
          {owners.map(ownerOption)}
        </select>
        <input type="search" aria-label="商品リストを検索" placeholder="検索" value={query} disabled={deleting || confirmation.pending} onChange={event => { setSelected(new Set()); setQuery(event.target.value); }} />
        <button className="btn" onClick={() => downloadCsv('products.csv', rows as unknown as Record<string, unknown>[])}>CSV</button>
        <button type="button" className="btn" disabled={loading || busy || deleting || confirmation.pending || !selectedRows.length} onClick={askDelete}>削除</button>
        <span className="sub product-result-count">{rows.length} 件</span>
      </div>

      {error && <div className="error">{error}</div>}
      {ownerError && <div className="error" role="alert">{ownerError}</div>}
      {message && <p role="status">{message}</p>}

      <div className="scroll">
        <table className="products-table product-catalog-table" aria-label="商品リスト">
          <thead>
            <tr>
              <th className="num">品番</th><th>ASIN</th><th>型番</th><th>メーカー</th>
              {!ownerFilter && <th>管理者</th>}<th>ジャンル</th><th>回転</th><th>Amazon販売金額</th>
              <th className="num">販売想定金額</th><th className="num">振込想定金額</th>
              <th className="num">仕入れ目標金額</th><th>実績</th><th>サイズ</th><th aria-label="選択" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="num"><button type="button" className="inventory-cell-edit" title="クリックして商品情報全体を編集" onClick={() => startFullEdit(p)}>{String(p.product_no ?? '—')}</button></td>
                <td><span className="reference-value">{cell(p, 'asin', p.asin)}<a className="inline-reference-link" href={p.amazon_url} target="_blank" rel="noreferrer" aria-label={`${p.asin}をAmazonで開く`}><span className="external-link-arrow" aria-hidden="true" /></a></span></td>
                <td>{cell(p, 'model_no', p.model_no ?? '—')}</td>
                <td>{cell(p, 'maker', p.maker ?? '—')}</td>
                {!ownerFilter && <td>{ownerNames.get(p.owner_staff_id ?? '') ?? '—'}</td>}
                <td>{cell(p, 'genre', p.genre ?? '—')}</td>
                <td>{cell(p, 'turnover', p.turnover ?? '—')}</td>
                <td>{(() => {
                  const average = recentAmazonAverage(p.id);
                  const historyCount = summaries[p.id]?.history_count ?? 0;
                  return historyCount > 0
                    ? <button className="inventory-cell-edit" title={average ? '直近' + average.count + '件のAmazon販売金額の平均' : '販売履歴を表示'} onClick={() => setHistoryProduct(p)}>
                        {average ? yen(average.amount) : '—'}{average ? <small>（{average.count}件）</small> : null}
                      </button>
                    : '—';
                })()}</td>
                <td className="num">{cell(p, 'list_price', yen(p.list_price))}</td>
                <td className="num">{cell(p, 'payout_estimate', yen(p.payout_estimate))}</td>
                <td className="num" style={{ color: 'var(--accent)' }}>{cell(p, 'target_cost', yen(p.target_cost))}</td>
                <td>{cell(p, 'has_sold_before', p.has_sold_before ? '有' : '無')}</td>
                <td><button type="button" className="inventory-cell-edit" title="クリックしてサイズ区分・配送サイズを変更" onClick={() => startSizeEdit(p)}>{p.shipping_category ? `${p.shipping_category} ${p.shipping_size ? shippingSizeLabel(p.shipping_size) : '未設定'}` : p.shipping_size ? shippingSizeLabel(p.shipping_size) : '未設定'}</button></td>
                <td><label className="expense-selection"><input type="checkbox" aria-label={`${p.model_no || p.asin}（${p.asin}）を選択`} checked={selected.has(p.id)} disabled={loading || busy || deleting || confirmation.pending} onChange={event => { const checked = event.target.checked; setSelected(current => { const next = new Set(current); if (checked) next.add(p.id); else next.delete(p.id); return next; }); }} /></label></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </section>
      <form className="card product-entry registration-sidebar registration-form" aria-label="商品登録" onSubmit={event => { event.preventDefault(); if (!busy) void addProduct(); }}>
        <div className="toolbar"><h2>商品登録</h2></div>
        <fieldset className="product-registration-fields registration-fields" disabled={busy}>
          {([['asin', 'ASIN'], ['model_no', '型番'], ['maker', 'メーカー']] as const).map(([field, label]) =>
            <label className="field" key={field}><span>{label}</span><input value={newProduct[field]} onChange={e => setNewProduct(current => ({ ...current, [field]: e.target.value }))} /></label>)}
          <label className="field"><span>ジャンル</span><select value={newProduct.genre} onChange={e => setNewProduct(current => ({ ...current, genre: e.target.value }))}>
            <option value="">未設定</option>{PRODUCT_GENRES.map(genre => <option key={genre}>{genre}</option>)}
          </select></label>
          <label className="field"><span>回転</span><select value={newProduct.turnover} onChange={e => setNewProduct(current => ({ ...current, turnover: e.target.value }))}>
            <option value="">未設定</option>{PRODUCT_TURNOVER.map(turnover => <option key={turnover}>{turnover}</option>)}
          </select></label>
          <label className="field"><span>販売想定金額</span><input type="number" min={0} step={1} value={newProduct.list_price} onChange={e => setNewProduct(current => ({ ...current, list_price: e.target.value }))} /></label>
          <label className="field"><span>サイズ区分</span><select value={newProduct.shipping_category} onChange={e => {
            const category = e.target.value;
            setNewProduct(current => ({ ...current, shipping_category: category, shipping_size: PRODUCT_SHIPPING_CATEGORIES.find(option => option.value === category)?.defaultSize ?? current.shipping_size }));
          }}>
            <option value="">未設定</option>{PRODUCT_SHIPPING_CATEGORIES.map(({ value, label }) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label className="field"><span>配送サイズ</span><select value={newProduct.shipping_size} onChange={e => setNewProduct(current => ({ ...current, shipping_size: e.target.value }))}>
            <option value="">未設定</option>{PRODUCT_SHIPPING_SIZES.map(size => <option value={size} key={size}>{shippingSizeLabel(size)}</option>)}
          </select></label>
          <div className="field"><span>振込想定金額</span><output aria-label="振込想定金額">{yen(newProductEstimates.payout_estimate)}</output></div>
          <div className="field"><span>仕入れ目標金額</span><output aria-label="仕入れ目標金額">{yen(newProductEstimates.target_cost)}</output></div>
        </fieldset>
        <div className="toolbar registration-actions"><button type="submit" className="btn primary" disabled={busy}>{busy ? '登録中…' : '商品登録'}</button></div>
        {error && <div className="error" role="alert">{error}</div>}
      </form>
      </div>
      {fullEditProduct && fullEditDraft && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="商品情報全体を編集"><div className="card inventory-comment-panel product-full-edit-panel">
        <h3>商品情報を編集</h3><p className="sub">品番 {fullEditDraft.product_no || '未設定'} ・ {fullEditDraft.model_no || fullEditDraft.asin}</p>
        <div className="product-full-edit-grid">
          {([['product_no','品番'],['asin','ASIN'],['model_no','型番'],['maker','メーカー'],['genre','ジャンル'],['list_price','販売想定金額'],['payout_estimate','振込想定金額'],['target_cost','仕入れ目標金額']] as const).map(([key,label]) => <label className="field" key={key}><span>{label}</span><input type={['product_no','list_price','payout_estimate','target_cost'].includes(key) ? 'number' : 'text'} min={key === 'product_no' ? 1 : 0} value={fullEditDraft[key]} disabled={busy} onChange={e => setFullEditDraft(current => current && ({ ...current, [key]: e.target.value }))} /></label>)}
          <label className="field"><span>回転</span><select value={fullEditDraft.turnover} disabled={busy} onChange={e => setFullEditDraft(current => current && ({ ...current, turnover: e.target.value }))}><option value="">未設定</option>{['高','中','低'].map(v => <option key={v}>{v}</option>)}</select></label>
          <label className="field"><span>実績</span><select value={fullEditDraft.has_sold_before} disabled={busy} onChange={e => setFullEditDraft(current => current && ({ ...current, has_sold_before: e.target.value }))}><option value="false">無</option><option value="true">有</option></select></label>
          <label className="field"><span>サイズ区分</span><select value={fullEditDraft.shipping_category} disabled={busy} onChange={e => setFullEditDraft(current => current && ({ ...current, shipping_category: e.target.value, shipping_size: e.target.value === 'モ' ? '140' : e.target.value === 'ブ' ? '100' : e.target.value === '小' ? '' : current.shipping_size }))}><option value="">未設定</option><option value="モ">モニター（モ）</option><option value="ブ">ブルーレイレコーダー（ブ）</option><option value="小">小物（小）</option></select></label>
          <label className="field"><span>配送サイズ</span><select value={fullEditDraft.shipping_size} disabled={busy} onChange={e => setFullEditDraft(current => current && ({ ...current, shipping_size: e.target.value }))}><option value="">未設定</option>{['60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].map(v => <option key={v} value={v}>{v}{/^\d+$/.test(v) ? 'サイズ' : ''}</option>)}</select></label>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void saveFullEdit()}>{busy ? '保存中…' : '保存'}</button><button className="btn" disabled={busy} onClick={() => { setFullEditProduct(null); setFullEditDraft(null); }}>閉じる</button></div>
      </div></div>}
      {sizeEditProduct && sizeEditDraft && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="サイズ区分と配送サイズを編集"><div className="card inventory-comment-panel">
        <h3>サイズ設定を編集</h3><p className="sub">品番 {sizeEditProduct.product_no ?? '未設定'} ・ {sizeEditProduct.model_no || sizeEditProduct.asin}</p>
        <label className="field"><span>サイズ区分</span><select value={sizeEditDraft.shipping_category} disabled={busy} onChange={e => setSizeEditDraft(current => current && ({ ...current, shipping_category: e.target.value, shipping_size: e.target.value === 'モ' ? '140' : e.target.value === 'ブ' ? '100' : e.target.value === '小' ? '' : current.shipping_size }))}><option value="">未設定</option><option value="モ">モニター（モ）</option><option value="ブ">ブルーレイレコーダー（ブ）</option><option value="小">小物（小）</option></select></label>
        <label className="field"><span>配送サイズ</span><select value={sizeEditDraft.shipping_size} disabled={busy} onChange={e => setSizeEditDraft(current => current && ({ ...current, shipping_size: e.target.value }))}><option value="">未設定</option>{['60','80','100','120','140','160','180','200','ネコポス','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット'].map(v => <option key={v} value={v}>{v}{/^\d+$/.test(v) ? 'サイズ' : ''}</option>)}</select></label>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void saveSizeEdit()}>{busy ? '保存中' : '保存'}</button><button className="btn" disabled={busy} onClick={() => { setSizeEditProduct(null); setSizeEditDraft(null); }}>閉じる</button></div>
      </div></div>}
      {editing && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="商品リストの項目を編集"><div className="card inventory-comment-panel">
        <h3>{fieldLabels[editing.field]}を編集</h3>
        <label className="field"><span>{fieldLabels[editing.field]}</span>
          {editing.field === 'turnover' || editing.field === 'has_sold_before' ? <select value={editing.value} onChange={e => setEditing(current => current && { ...current, value: e.target.value })}>{(editing.field === 'turnover' ? [['', '未設定'], ['高', '高'], ['中', '中'], ['低', '低']] : [['false', '無'], ['true', '有']]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            : <input autoFocus type={['product_no', 'list_price', 'payout_estimate', 'target_cost'].includes(editing.field) ? 'number' : 'text'} min={editing.field === 'product_no' ? 1 : 0} value={editing.value} onChange={e => setEditing(current => current && { ...current, value: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void saveEdit(); }} />}
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="toolbar"><button className="btn primary" disabled={busy} onClick={() => void saveEdit()}>保存</button><button className="btn" disabled={busy} onClick={() => setEditing(null)}>閉じる</button></div>
      </div></div>}
      {historyProduct && <div className="inventory-edit-overlay" role="dialog" aria-modal="true" aria-label="過去の販売履歴">
        <div className="card inventory-comment-panel product-history-panel">
          <h3>過去の販売履歴</h3>
          <p className="sub">{historyProduct.product_no ? '品番 ' + historyProduct.product_no + ' ・ ' : ''}{historyProduct.model_no || historyProduct.asin}</p>
          {historyLoading&&<p role="status">読み込み中…</p>}{historyError&&<p className="error" role="alert">{historyError}</p>}
          <div className="scroll"><table className="products-table">
            <thead><tr><th>販売日</th><th>SKU</th><th>販売先</th><th className="num">販売金額</th><th className="num">振込金額</th></tr></thead>
            <tbody>{(!historyLoading&&!historyError?salesByProduct[historyProduct.id] ?? []:[]).map(sale => <tr key={sale.id}>
              <td>{sale.sold_on}</td><td>{sale.sku}</td><td><ColoredLabel value={sale.sales_channel ?? '—'} /></td>
              <td className="num">{yen(sale.sold_price)}</td><td className="num">{yen(sale.payout_amount)}</td>
            </tr>)}</tbody>
          </table></div>
          <div className="toolbar"><button className="btn" onClick={() => setHistoryProduct(null)}>閉じる</button></div>
        </div>
      </div>}
    </>
  );
}
