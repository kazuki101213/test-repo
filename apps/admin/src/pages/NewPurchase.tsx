import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CONDITIONS, MARKETPLACES, SALES_CHANNELS, WORK_STREAMS, yen,
} from '@bussan/shared';
import type {
  ItemCondition, ItemInsert, Marketplace, Product, SalesChannel, Staff, WorkStream,
} from '@bussan/shared';
import { createItem, fetchCards, fetchProducts, fetchStaff, nextLotSeq } from '../api';
import { buildPurchaseUrl, parsePurchaseUrl } from '../purchaseUrl';

const today = () => new Date().toISOString().slice(0, 10);
const purchaserNames = ['長部一輝', '石川秀樹'];
const workStreamLabels: Record<WorkStream, string> = { 'テレビ': 'モニター・テレビ', 'ブルーレイ': 'ブルーレイレコーダー', '付属品': '付属品', 'その他': '小物' };
const handoffTemplates = [
  '着払いです。',
  '動作確認は出来る環境があればやってください。\nできなければ大丈夫です。',
  '付属品は揃っていますか。',
];

export default function NewPurchase({ me, onSaved }: { me: Staff; onSaved?: () => void }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [purchaserId, setPurchaserId] = useState(me.id);
  const [delivererId, setDelivererId] = useState('');
  const [workStream, setWorkStream] = useState<WorkStream | ''>('');
  const [lotSeq, setLotSeq] = useState<number | ''>('');
  const [purchasedAt, setPurchasedAt] = useState(today());
  const [productId, setProductId] = useState('');
  const [title, setTitle] = useState('');
  const [cost, setCost] = useState<number | ''>('');
  const [marketplace, setMarketplace] = useState<Marketplace>('メルカリ');
  const [marketplaceItemId, setMarketplaceItemId] = useState('');
  const [urlOverride, setUrlOverride] = useState<string | null>(null);
  const generatedReference = buildPurchaseUrl(marketplace, marketplaceItemId);
  const marketplaceUrl = urlOverride ?? generatedReference?.url ?? '';
  const [cardId, setCardId] = useState('');
  const [condition, setCondition] = useState<ItemCondition | ''>('非常に良い');
  const [salesChannel, setSalesChannel] = useState<SalesChannel>('FBA');
  const [plannedPrice, setPlannedPrice] = useState<number | ''>('');
  const [plannedPayout, setPlannedPayout] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchStaff().then(rows => {
      setStaff(rows);
      setPurchaserId(current => rows.some(s => s.id === current && s.role !== 'deliverer' && purchaserNames.includes(s.name))
        ? current : rows.find(s => s.name === purchaserNames[0] && s.role !== 'deliverer')?.id ?? '');
    }).catch((e) => setError(String(e)));
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
  // 利益が出ない仕入れはその場で気づけるようにする
  const overTarget = product?.target_cost != null && cost !== '' && Number(cost) > product.target_cost;

  function changeItemId(value: string) {
    const parsed = parsePurchaseUrl(value);
    if (parsed) setMarketplace(parsed.marketplace as Marketplace);
    setMarketplaceItemId(parsed?.itemId ?? value);
    setUrlOverride(null);
  }

  function changePurchaseUrl(value: string) {
    const parsed = parsePurchaseUrl(value);
    if (parsed) {
      setMarketplace(parsed.marketplace as Marketplace);
      setMarketplaceItemId(parsed.itemId);
      setUrlOverride(null);
    } else setUrlOverride(value);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (!purchaser || purchaser.role === 'deliverer' || !purchaserNames.includes(purchaser.name)) throw new Error('仕入担当者を選択してください。');
      if (marketplaceUrl.trim()) {
        let url: URL;
        try { url = new URL(marketplaceUrl.trim()); }
        catch { throw new Error('仕入れURLは https:// から始まるURLを入力してください。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仕入れURLの形式を確認してください。');
      }
      const payload: ItemInsert = {
        lot_seq: lotSeq === '' ? undefined : Number(lotSeq),
        purchaser_id: purchaserId,
        deliverer_id: delivererId || null,
        work_stream: workStream || null,
        purchased_at: purchasedAt,
        title: title.trim(),
        cost_amount: Number(cost),
        marketplace,
        marketplace_item_id: generatedReference?.itemId ?? (marketplaceItemId.trim() || null),
        marketplace_url: marketplaceUrl.trim() || null,
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
      // 続けて同じ商品の仕入れを登録できるよう、通番号と担当者は残す
      setTitle(''); setCost(''); setMarketplaceItemId(''); setUrlOverride(null);
      setProductId(''); setNote(''); setTemplatesOpen(false);
      onSaved?.();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>仕入登録</h2>

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
                <select value={marketplace} onChange={(e) => { setMarketplace(e.target.value as Marketplace); setUrlOverride(null); }}>
                  {MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="field"><span>支払い方法</span>
                <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
                  <option value="">—</option>
                  {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="field"><span>商品ID（仕入先の商品番号）</span>
                <input type="text" value={marketplaceItemId} onChange={(e) => changeItemId(e.target.value)} placeholder="商品ID または 商品ページのURL" />
              </label>
              <label className="field"><span>仕入れURL</span>
                <input type="url" value={marketplaceUrl} onChange={(e) => changePurchaseUrl(e.target.value)} placeholder="仕入先と商品IDから自動入力" />
              </label>
            </div>
            {marketplaceItemId.trim() && !generatedReference && !marketplaceUrl && <p className="sub" role="status">商品IDの形式を確認するか、仕入れURLを直接貼り付けてください。ラクマは商品URL末尾の32文字のIDを使います。</p>}
          </div>

          <div className="card">
            <h3>商品</h3>
            <label className="field"><span>商品リスト（ASIN）</span>
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
                  {staff.filter(s => s.role !== 'deliverer' && purchaserNames.includes(s.name)).map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}
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
                  {WORK_STREAMS.map((w) => <option key={w} value={w}>{workStreamLabels[w]}</option>)}
                </select>
              </label>
              <label className="field"><span>通番号</span>
                <input type="number" min={1} value={lotSeq} onChange={(e) => setLotSeq(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="purchase-handoff">納品担当者への申し送り</label>
              <div className="handoff-input" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setTemplatesOpen(false); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setTemplatesOpen(false); } }}>
                <textarea ref={noteInput} id="purchase-handoff" value={note} onChange={e => setNote(e.target.value)} placeholder="手入力、または右の▼から定型文を選択" />
                <button type="button" className="handoff-toggle" aria-label="申し送りの定型文を選択" aria-expanded={templatesOpen} aria-controls="handoff-templates" onClick={() => setTemplatesOpen(open => !open)}>▼</button>
                {templatesOpen && <div id="handoff-templates" className="handoff-options">
                  {handoffTemplates.map(template => <button type="button" key={template} onClick={() => {
                    setNote(current => current ? `${current.trimEnd()}\n${template}` : template);
                    setTemplatesOpen(false);
                    noteInput.current?.focus();
                  }}>{template}</button>)}
                </div>}
              </div>
            </div>
          </div>
        </div>
        <button className="btn primary" style={{ marginTop: 16, width: '100%' }} disabled={busy}>{busy ? '登録中…' : '登録する'}</button>
      </form>
    </>
  );
}
