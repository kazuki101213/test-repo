import { useState } from 'react';
import { getSupabase } from '@bussan/shared';

type Row = { sku: string; asin: string; name: string; total: number; fulfillable: number | null; reserved: number | null; status: string[] | null };
type Result = { rows: Row[]; nextToken?: string; fetchedAt: string };

export default function AmazonInventory() {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function load(nextToken?: string) {
    setLoading(true); setError('');
    try {
      const { data, error: failure } = await getSupabase().functions.invoke('amazon-fba-inventory', { body: { nextToken } });
      if (failure) {
        let message = '取得できませんでした。ログイン状態とEdge Functionのデプロイ・設定を確認してください。';
        if (failure.context instanceof Response) {
          const body = await failure.context.json().catch(() => null);
          if (typeof body?.error === 'string') message = body.error;
        }
        throw new Error(message);
      }
      setResult(data as Result);
    } catch (e) { setError(e instanceof Error ? e.message : '取得に失敗しました。'); }
    finally { setLoading(false); }
  }
  return <>
    <h2>Amazon FBA</h2>
    <p className="sub">Amazon.co.jpのFBA在庫・出品状態を読み取り専用で確認します。Amazonへの更新やデータの保存は行いません。</p>
    <div className="toolbar">
      <button className="btn" disabled={loading} onClick={() => void load()}>最新の在庫を取得</button>
      {result?.nextToken && <button className="btn" disabled={loading} onClick={() => void load(result.nextToken)}>次のページ</button>}
    </div>
    {loading && <p role="status">取得中…</p>}
    {error && <div className="error" role="alert">{error}</div>}
    {result && <>
      <p>表示中のページ: {result.rows.length}件 ／ 取得日時: {new Date(result.fetchedAt).toLocaleString('ja-JP')}{loading || error ? '（前回取得したデータ）' : ''}</p>
      <div className="scroll"><table><thead><tr><th>SKU</th><th>ASIN</th><th>商品名</th><th>FBA合計</th><th>販売可能</th><th>予約済み</th><th>出品状態</th></tr></thead>
        <tbody>{result.rows.map(row => <tr key={row.sku}><td>{row.sku}</td><td>{row.asin}</td><td>{row.name}</td><td>{row.total}</td><td>{row.fulfillable ?? '不明'}</td><td>{row.reserved ?? '不明'}</td><td>{row.status?.join(' / ') || '取得結果なし'}</td></tr>)}</tbody>
      </table></div>
      {result.rows.length === 0 && <p>このページにFBA在庫はありません。</p>}
      <p className="sub">BUYABLE: 購入可能 ／ DISCOVERABLE: 検索表示対象。状態が取得できない場合は出品停止とは判定しません。</p>
    </>}
  </>;
}
