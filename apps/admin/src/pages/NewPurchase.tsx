import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CONDITIONS, MARKETPLACES, SALES_CHANNELS, WORK_STREAMS, buildSku, yen,
} from '@bussan/shared';
import type {
  ItemCondition, ItemInsert, Marketplace, Product, SalesChannel, Staff, WorkStream,
} from '@bussan/shared';
import { createItem, fetchCards, fetchProducts, fetchStaff, nextLotSeq } from '../api';

const today = () => new Date().toISOString().slice(0, 10);

export default function NewPurchase({ me }: { me: Staff }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [purchaserId, setPurchaserId] = useState(me.id);
  const [delivererId, setDelivererId] = useState('');
  const [workStream, setWorkStream] = useState<WorkStream | ''>('');
  const [lotSeq, setLotSeq] = useState<number | ''>('');
  const [isAccessory, setIsAccessory] = useState(false);
  const [purchasedAt, setPurchasedAt] = useState(today());
  const [productId, setProductId] = useState('');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState<number | ''>('');
  const [marketplace, setMarketplace] = useState<Marketplace>('メルカリ');
  const [marketplaceItemId, setMarketplaceItemId] = useState('');
  const [marketplaceUrl, setMarketplaceUrl] = useState('');
  const [cardId, setCardId] = useState('');
  const [condition, setCondition] = useState<ItemCondition | ''>('非常に良い');
  const [salesChannel, setSalesChannel] = useState<SalesChannel>('FBA');
  const [plannedPrice, setPlannedPrice] = useState<number | ''>('');
  const [plannedPayout, setPlannedPayout] = useState<number | ''>('');
  const [note, setNote] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchStaff().then(setStaff).catch((e) => setError(String(e)));
    fetchCards().then(setCards).catch(() => undefined);
    fetchProducts().then(setProducts).catch(() => undefined);
    nextLotSeq().then(setLotSeq).catch(() => undefined);
  }, []);

  const product = products.find((p) => p.id === productId);

  // 商品マスタを選んだら、想定販売価格と振込額を引き継ぐ
  useEffect(() => {
    if (!product) return;
    setTitle((t) => t || product.model_no || '');
    setPlannedPrice(product.list_price ?? '');
    setPlannedPayout(product.payout_estimate ?? '');
  }, [product]);

  const purchaser = staff.find((s) => s.id === purchaserId);
  const deliverer = staff.find((s) => s.id === delivererId);

  // 保存前に SKU を確認できるようにする（DB 側の app.build_sku と同じ規則）
  const skuPreview = useMemo(() => {
    if (!purchaser || lotSeq === '' || cost === '') return null;
    try {
      return buildSku({
        lotSeq, purchaserCode: purchaser.code, delivererCode: deliverer?.code,
        purchasedAt, costAmount: Number(cost),
      });
    } catch {
      return null;
    }
  }, [purchaser, deliverer, lotSeq, cost, purchasedAt]);

  // 利益が出ない仕入れはその場で気づけるようにする
  const expected = plannedPayout !== '' && cost !== '' ? Number(plannedPayout) - Number(cost) : null;
  const overTarget = product?.target_cost != null && cost !== '' && Number(cost) > product.target_cost;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const payload: ItemInsert = {
        lot_seq: lotSeq === '' ? undefined : Number(lotSeq),
        is_accessory: isAccessory,
        purchaser_id: purchaserId,
        deliverer_id: delivererId || null,
        work_stream: workStream || null,
        purchased_at: purchasedAt,
        title: title.trim(),
        cost_amount: Number(cost),
        marketplace,
        marketplace_item_id: marketplaceItemId || null,
        marketplace_url: marketplaceUrl || null,
        card_id: cardId || null,
        product_id: productId || null,
        asin: product?.asin ?? null,
        condition: condition || null,
        planned_price: plannedPrice === '' ? null : Number(plannedPrice),
        planned_payout: plannedPayout === '' ? null : Number(plannedPayout),
        sales_channel: salesChannel,
        memo: note || null,
      };

      const created = await createItem(payload);
      setDone(`登録しました: ${created.sku}`);
      // 続けて同じロットの付属品を登録することが多いので、ロットと担当者は残す
      setTitle(''); setCost(''); setMarketplaceItemId(''); setMarketplaceUrl('');
      setProductId(''); setNote('');
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>仕入登録</h2>
      <p className="sub">
        登録すると SKU が自動で発番され、納品担当者のアプリにその場で現れます。
      </p>

      {done && <div className="ok">{done}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={submit}>
        <div className="grid cols2">
          <div className="card">
            <h3>仕入れ</h3>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label className="field"><span>購入日</span>
                <input type="date" value={purchasedAt} onChange={(e) => setPurchasedAt(e.target.value)} required />
              </label>
              <label className="field"><span>仕入金額（円）</span>
                <input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value === '' ? '' : Number(e.target.value))} required />
              </label>
              <label className="field"><span>仕入先</span>
                <select value={marketplace} onChange={(e) => setMarketplace(e.target.value as Marketplace)}>
                  {MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="field"><span>支払いカード</span>
                <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
                  <option value="">—</option>
                  {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="field"><span>取引ID（m123… / q123…）</span>
                <input type="text" value={marketplaceItemId} onChange={(e) => setMarketplaceItemId(e.target.value)} />
              </label>
              <label className="field"><span>商品URL</span>
                <input type="text" value={marketplaceUrl} onChange={(e) => setMarketplaceUrl(e.target.value)} />
              </label>
            </div>
            <p className="sub" style={{ margin: '10px 0 0' }}>
              取引IDとURLは古物台帳の「相手方の確認」の記録になります。必ず残してください。
            </p>
          </div>

          <div className="card">
            <h3>商品</h3>
            <label className="field"><span>商品マスタ（ASIN）</span>
              <select value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">— マスタを使わない —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.product_no ? `${p.product_no}. ` : ''}{p.model_no ?? p.asin} / {p.maker ?? ''} / 目標 {p.target_cost ? yen(p.target_cost) : '—'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ marginTop: 8 }}><span>商品名</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="DMR-BRZ1020" />
            </label>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 8 }}>
              <label className="field"><span>コンディション</span>
                <select value={condition} onChange={(e) => setCondition(e.target.value as ItemCondition)}>
                  <option value="">—</option>
                  {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="field"><span>販売先</span>
                <select value={salesChannel} onChange={(e) => setSalesChannel(e.target.value as SalesChannel)}>
                  {SALES_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="field"><span>販売予定価格</span>
                <input type="number" min={0} value={plannedPrice} onChange={(e) => setPlannedPrice(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
              <label className="field"><span>振込予定額</span>
                <input type="number" min={0} value={plannedPayout} onChange={(e) => setPlannedPayout(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
            </div>
            {overTarget && (
              <div className="error" style={{ marginBottom: 0 }}>
                仕入れ目標（{yen(product?.target_cost)}）を超えています。
              </div>
            )}
          </div>

          <div className="card">
            <h3>担当</h3>
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label className="field"><span>仕入担当者</span>
                <select value={purchaserId} onChange={(e) => setPurchaserId(e.target.value)} required>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
                </select>
              </label>
              <label className="field"><span>納品担当者</span>
                <select value={delivererId} onChange={(e) => setDelivererId(e.target.value)}>
                  <option value="">— 未定 —</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
                </select>
              </label>
              <label className="field"><span>作業ライン</span>
                <select value={workStream} onChange={(e) => setWorkStream(e.target.value as WorkStream)}>
                  <option value="">—</option>
                  {WORK_STREAMS.map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </label>
              <label className="field"><span>通番号</span>
                <input type="number" min={1} value={lotSeq} onChange={(e) => setLotSeq(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
            </div>
            <label className="row" style={{ marginTop: 10, color: 'var(--muted)' }}>
              <input type="checkbox" checked={isAccessory} onChange={(e) => setIsAccessory(e.target.checked)} />
              &nbsp;付属品（リモコン等）として同じ通番号にぶら下げる
            </label>
            <label className="field" style={{ marginTop: 10 }}><span>納品担当者への申し送り</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="着払いです / 電源ケーブル欠品の可能性あり" />
            </label>
          </div>

          <div className="card">
            <h3>確認</h3>
            <p className="kpi-label">発番される SKU</p>
            <p className="sku" style={{ fontSize: 16 }}>{skuPreview ?? '— 担当者・通番号・仕入金額を入力してください —'}</p>
            <p className="kpi-label" style={{ marginTop: 14 }}>見込み利益</p>
            <p className="kpi-value" style={{ color: expected == null ? undefined : expected >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
              {expected == null ? '—' : yen(expected)}
            </p>
            <button className="btn primary" style={{ marginTop: 16, width: '100%' }} disabled={busy}>
              {busy ? '登録中…' : 'この内容で登録する'}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}
