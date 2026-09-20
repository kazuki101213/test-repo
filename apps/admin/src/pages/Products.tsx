import { useEffect, useState } from 'react';
import { yen, errorMessage } from '@bussan/shared';
import type { Product } from '@bussan/shared';
import { fetchProducts } from '../api';
import { downloadCsv } from '../csv';

export default function Products() {
  const [rows, setRows] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      fetchProducts(query || undefined)
        .then(setRows)
        .catch((e) => setError(errorMessage(e)));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  return (
    <>
      <h2>商品マスタ</h2>
      <p className="sub">総合管理表の「商品リスト」。仕入れ目標を下回る値段で買えるかの判断に使います。</p>

      <div className="toolbar">
        <input
          type="search" placeholder="ASIN / 型番 / メーカー" value={query}
          onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 260 }}
        />
        <span className="sub" style={{ margin: 0 }}>{rows.length} 件</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => downloadCsv('products.csv', rows as unknown as Record<string, unknown>[])}>CSV</button>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th className="num">No</th><th>ASIN</th><th>型番</th><th>メーカー</th>
              <th>ジャンル</th><th>回転</th>
              <th className="num">販売価格</th><th className="num">振込額</th>
              <th className="num">仕入れ目標</th><th className="num">月間上限</th><th>実績</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="num">{p.product_no ?? '—'}</td>
                <td><a href={p.amazon_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{p.asin}</a></td>
                <td>{p.model_no ?? '—'}</td>
                <td>{p.maker ?? '—'}</td>
                <td>{p.genre ?? '—'}</td>
                <td>{p.turnover ?? '—'}</td>
                <td className="num">{yen(p.list_price)}</td>
                <td className="num">{yen(p.payout_estimate)}</td>
                <td className="num" style={{ color: 'var(--accent)' }}>{yen(p.target_cost)}</td>
                <td className="num">{p.monthly_purchase_cap ?? '—'}</td>
                <td>{p.has_sold_before ? <span className="badge">販売実績あり</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
