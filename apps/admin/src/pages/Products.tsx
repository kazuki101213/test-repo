import { useEffect, useState } from 'react';
import { yen } from '@bussan/shared';
import type { Product } from '@bussan/shared';
import { createProduct, fetchProductSaleHistory, fetchProducts, updateProductField, type ProductField, type ProductSaleHistory } from '../api';
import { downloadCsv } from '../csv';

export default function Products() {
  const [rows, setRows] = useState<Product[]>([]);
  const [salesByProduct, setSalesByProduct] = useState<Record<string, ProductSaleHistory[]>>({});
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newProduct, setNewProduct] = useState({ asin: '', model_no: '', maker: '', product_no: '' });
  const [editing, setEditing] = useState<{ product: Product; field: ProductField; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      fetchProducts(query || undefined)
        .then(async products => {
          if (cancelled) return;
          setRows(products);
          const sales = await fetchProductSaleHistory(products);
          if (cancelled) return;
          const grouped: Record<string, ProductSaleHistory[]> = {};
          for (const sale of sales) (grouped[sale.product_id] ??= []).push(sale);
          setSalesByProduct(grouped);
        })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [query, revision]);

  async function saveEdit() {
    if (!editing) return;
    setBusy(true); setError(null);
    try { await updateProductField(editing.product, editing.field, editing.value); setEditing(null); setRevision(n => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function addProduct() {
    setBusy(true); setError(null);
    try { await createProduct(newProduct); setNewProduct({ asin: '', model_no: '', maker: '', product_no: '' }); setAdding(false); setRevision(n => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const fieldLabels: Record<ProductField, string> = {
    product_no: '品番', asin: 'ASIN', model_no: '型番', maker: 'メーカー', genre: 'ジャンル',
    turnover: '回転', list_price: '販売想定金額', payout_estimate: '振込想定金額', target_cost: '仕入れ目標金額',
    has_sold_before: '実績',
  };
  const startEdit = (product: Product, field: ProductField) => setEditing({ product, field, value: String(product[field] ?? '') });
  const cell = (product: Product, field: ProductField, label: string) => <button className="inventory-cell-edit" onClick={() => startEdit(product, field)}>{label}</button>;
  const recentAmazonAverage = (productId: string) => {
    const sales = (salesByProduct[productId] ?? [])
      .filter(sale => (sale.sales_channel === 'FBA' || sale.sales_channel === '自己発送') && sale.sold_price !== null)
      .sort((a, b) => b.sold_on.localeCompare(a.sold_on) || a.id.localeCompare(b.id))
      .slice(0, 3);
    if (sales.length === 0) return null;
    return { amount: Math.round(sales.reduce((sum, sale) => sum + (sale.sold_price ?? 0), 0) / sales.length), count: sales.length };
  };

  return (
    <>
      <h2>商品リスト</h2>
      <p className="sub">総合管理表の「商品リスト」。仕入れ目標金額を下回る値段で買えるかの判断に使います。</p>

      <div className="toolbar">
        <input
          type="search" placeholder="品番 / ASIN / 型番 / メーカー / ジャンル" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 260 }}
        />
        <span className="sub" style={{ margin: 0 }}>{rows.length} 件</span>
        <span style={{ flex: 1 }} />
        <button className="btn" aria-expanded={adding} onClick={() => setAdding(open => !open)}>{adding ? '商品登録を閉じる' : '商品登録'}</button>
        <button className="btn" onClick={() => downloadCsv('products.csv', rows as unknown as Record<string, unknown>[])}>CSV</button>
      </div>

      {adding && <div className="card product-entry"><h3>商品登録</h3><div className="grid cols2">
        {(['asin', 'model_no', 'maker', 'product_no'] as const).map(field => <label className="field" key={field}><span>{{ asin: 'ASIN', model_no: '型番', maker: 'メーカー', product_no: '品番' }[field]}</span><input value={newProduct[field]} onChange={e => setNewProduct(current => ({ ...current, [field]: e.target.value }))} /></label>)}
      </div><button className="btn primary" disabled={busy} onClick={() => void addProduct()}>保存</button></div>}

      {error && <div className="error">{error}</div>}

      <div className="scroll">
        <table className="products-table">
          <thead>
            <tr>
              <th className="num">品番</th><th>ASIN</th><th>型番</th><th>メーカー</th>
              <th>ジャンル</th><th>回転</th><th>Amazon販売金額（直近3件平均）</th>
              <th className="num">販売想定金額</th><th className="num">振込想定金額</th>
              <th className="num">仕入れ目標金額</th><th>実績</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="num">{cell(p, 'product_no', String(p.product_no ?? '—'))}</td>
                <td>{cell(p, 'asin', p.asin)}<a href={p.amazon_url} target="_blank" rel="noreferrer" aria-label={`${p.asin}をAmazonで開く`}>↗</a></td>
                <td>{cell(p, 'model_no', p.model_no ?? '—')}</td>
                <td>{cell(p, 'maker', p.maker ?? '—')}</td>
                <td>{cell(p, 'genre', p.genre ?? '—')}</td>
                <td>{cell(p, 'turnover', p.turnover ?? '—')}</td>
                <td>{(() => {
                  const average = recentAmazonAverage(p.id);
                  const historyCount = salesByProduct[p.id]?.length ?? 0;
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          <div className="scroll"><table className="products-table">
            <thead><tr><th>販売日</th><th>SKU</th><th>販売先</th><th className="num">販売金額</th><th className="num">振込金額</th></tr></thead>
            <tbody>{(salesByProduct[historyProduct.id] ?? []).map(sale => <tr key={sale.id}>
              <td>{sale.sold_on}</td><td>{sale.sku}</td><td>{sale.sales_channel ?? '—'}</td>
              <td className="num">{yen(sale.sold_price)}</td><td className="num">{yen(sale.payout_amount)}</td>
            </tr>)}</tbody>
          </table></div>
          <div className="toolbar"><button className="btn" onClick={() => setHistoryProduct(null)}>閉じる</button></div>
        </div>
      </div>}
    </>
  );
}
