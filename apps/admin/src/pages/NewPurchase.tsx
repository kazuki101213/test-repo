import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CONDITIONS, MARKETPLACES, SALES_CHANNELS, WORK_STREAMS, yen,
  fetchSpareAccessories, getSupabase,
} from '@bussan/shared';
import type {
  ItemCondition, ItemInsert, Marketplace, Product, SalesChannel, Staff, WorkStream,
  PurchaseDraft, SpareAccessory,
} from '@bussan/shared';
import { createItem, fetchCards, findInventoryForAmazonReturn, fetchProducts, fetchStaff, nextLotSeq } from '../api';
import { buildPurchaseUrl, parsePurchaseUrl } from '../purchaseUrl';

const today = () => new Date().toISOString().slice(0, 10);
const purchaserNames = ['長部一輝', '石川秀樹'];
const workStreamLabels: Record<WorkStream, string> = { 'テレビ': 'モニター・テレビ', 'ブルーレイ': 'ブルーレイレコーダー', '付属品': '付属品', 'その他': '小物' };
const handoffTemplates = [
  '着払いです。',
  '動作確認は出来る環境があればやってください。\nできなければ大丈夫です。',
  '付属品は揃っていますか。',
];

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === 'object') {
    const value = cause as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [value.message, value.details, value.hint]
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (parts.length) return parts.join(' ');
    if (typeof value.code === 'string') return `データ参照エラー (${value.code})`;
  }
  return String(cause);
}

export default function NewPurchase({ me, onSaved, draft }: { me: Staff; onSaved?: () => void; draft?: PurchaseDraft | null }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [cards, setCards] = useState<{ id: string; name: string }[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [spares, setSpares] = useState<SpareAccessory[]>([]);
  const [spareId, setSpareId] = useState('');
  const availableSpares = spares.filter(row => !row.used_for_item_id);
  const selectedSpare = availableSpares.find(row => row.id === spareId);

  const [purchaserId, setPurchaserId] = useState(me.id);
  const [delivererId, setDelivererId] = useState('');
  const [workStream, setWorkStream] = useState<WorkStream | ''>('');
  const [lotSeq, setLotSeq] = useState<number | ''>('');
  const [purchasedAt, setPurchasedAt] = useState(today());
  const [trackingNo, setTrackingNo] = useState('');
  const [productId, setProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [title, setTitle] = useState('');
  const [asin, setAsin] = useState('');
  const [cost, setCost] = useState<number | ''>('');
  const [marketplace, setMarketplace] = useState<Marketplace>('メルカリ');
  const [returnSku, setReturnSku] = useState<string | null>(null);
  const [returnLookup, setReturnLookup] = useState('');
  const [marketplaceItemId, setMarketplaceItemId] = useState('');
  const [urlOverride, setUrlOverride] = useState<string | null>(null);
  const generatedReference = buildPurchaseUrl(marketplace, marketplaceItemId);
  const marketplaceUrl = urlOverride ?? generatedReference?.url ?? '';
  const isAmazonReturn = marketplace === 'Amazon返品';
  const isWorkingAmazonReturn = marketplace === '動作品Amazon返品';
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
    if (!draft) return;
    setMarketplace(draft.marketplace);
    setMarketplaceItemId(draft.marketplace_item_id);
    setUrlOverride(draft.marketplace_url);
    setTitle(draft.title);
    setPurchasedAt(draft.purchased_at || '');
    setCost(draft.cost_amount ?? '');
  }, [draft?.id]);

  useEffect(() => {
    fetchStaff().then(rows => {
      setStaff(rows);
      setPurchaserId(current => rows.some(s => s.id === current && s.role !== 'deliverer' && purchaserNames.includes(s.name))
        ? current : rows.find(s => s.name === purchaserNames[0] && s.role !== 'deliverer')?.id ?? '');
    }).catch((e) => setError(String(e)));
    fetchCards().then(setCards).catch(() => undefined);
    nextLotSeq().then(setLotSeq).catch(() => undefined);
    fetchSpareAccessories().then(setSpares).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (productId) return;
    const term = productSearch.trim();
    if (!term) { setProducts([]); return; }
    let active = true;
    const timer = setTimeout(() => { fetchProducts(term).then(rows => { if (active) setProducts(rows); }).catch(() => undefined); }, 220);
    return () => { active = false; clearTimeout(timer); };
  }, [productSearch, productId]);

  const product = products.find((p) => p.id === productId);

  // 商品マスタを選んだら、想定販売価格と振込額を引き継ぐ
  useEffect(() => {
    if (!product) return;
    setTitle(product.model_no || '');
    setAsin(product.asin || '');
    setPlannedPrice(product.list_price ?? '');
    setPlannedPayout(product.payout_estimate ?? '');
  }, [product]);
  useEffect(() => {
    if (!selectedSpare) return;
    setProductId('');
    setProductSearch('');
    setTitle(selectedSpare.title);
    setAsin('');
    setPlannedPrice('');
    setPlannedPayout('');
    if (selectedSpare.purchased_at) setPurchasedAt(selectedSpare.purchased_at);
    setCost(selectedSpare.cost_amount);
    setTrackingNo(selectedSpare.tracking_no ?? '');
    setMarketplaceItemId(selectedSpare.marketplace_item_id ?? '');
    setUrlOverride(null);
    setMarketplace(selectedSpare.marketplace && MARKETPLACES.includes(selectedSpare.marketplace as Marketplace)
      ? selectedSpare.marketplace as Marketplace : 'その他');
    const spareOwner = staff.find(row => row.id === selectedSpare.owner_staff_id && row.role !== 'deliverer' && purchaserNames.includes(row.name));
    if (spareOwner) setPurchaserId(spareOwner.id);
  }, [selectedSpare, staff]);
  useEffect(() => {
    if ((!isAmazonReturn && !isWorkingAmazonReturn) || lotSeq === '') {
      setReturnSku(null);
      setReturnLookup('');
      return;
    }
    let active = true;
    setReturnLookup('読み込み中…');
    void findInventoryForAmazonReturn(Number(lotSeq)).then(source => {
      if (!active) return;
      if (!source) {
        setReturnSku(null);
        setReturnLookup(`通番号 ${lotSeq} の本体が見つかりません。通番号を確認してください。`);
        return;
      }
      const specialSku = source.sku.replace(/^\d+[a-z]*(?=-)/i, `${lotSeq}b`);
      setReturnSku(isWorkingAmazonReturn ? specialSku : source.sku);
      setPurchaserId(current => source.purchaser_id ?? current);
      setDelivererId(current => source.deliverer_id ?? current);
      setWorkStream(source.work_stream ?? '');
      setPurchasedAt(source.purchased_at ?? today());
      setTitle(source.title);
      setCost(source.cost_amount);
      setProductId(isWorkingAmazonReturn ? '' : source.product_id ?? '');
      setProductSearch(isWorkingAmazonReturn ? '' : source.model_no || source.title);
      setAsin(source.asin ?? '');
      setCondition(source.condition ?? '');
      setPlannedPrice(source.planned_price ?? '');
      setPlannedPayout(source.planned_payout ?? '');
      setSalesChannel(source.sales_channel ?? 'FBA');
      setMarketplaceItemId(isWorkingAmazonReturn ? source.marketplace_item_id ?? '' : '');
      setTrackingNo('');
      setCardId('');
      setUrlOverride(null);
      setReturnLookup(isWorkingAmazonReturn
        ? `元商品 ${source.original_sku} の情報を反映しました。新しいSKU: ${specialSku}（通番号の直後にb）`
        : `元商品 ${source.original_sku} の情報を反映しました。新しい返品SKU: ${source.sku}`);
    }).catch(cause => {
      if (active) setReturnLookup(`元商品の情報を読み込めませんでした: ${errorMessage(cause)}`);
    });
    return () => { active = false; };
  }, [marketplace, lotSeq, isAmazonReturn, isWorkingAmazonReturn]);
  const matchingProducts = products;

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
      if ((isAmazonReturn || isWorkingAmazonReturn) && !returnSku) throw new Error('返品商品は、元商品の通番号を入力して情報を読み込んでください。');
      if (isWorkingAmazonReturn && (!asin.trim() || !title.trim() || !marketplaceItemId.trim())) throw new Error('動作品Amazon返品は、ASIN・FNSKU（型番欄）・EAN（商品ID欄）を入力してください。');
      if (marketplaceUrl.trim()) {
        let url: URL;
        try { url = new URL(marketplaceUrl.trim()); }
        catch { throw new Error('仕入先URLは https:// から始まるURLを入力してください。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仕入先URLの形式を確認してください。');
      }
      let assignedReturnSku = returnSku;
      if (isWorkingAmazonReturn && returnSku) {
        const assignedDeliverer = staff.find(row => row.id === delivererId && row.role === 'deliverer');
        if (!assignedDeliverer || !purchaser?.code || !assignedDeliverer.code) throw new Error('動作品Amazon返品は納品担当者を選択してください。');
        const parts = returnSku.split('-');
        if (parts.length !== 4) throw new Error('動作品Amazon返品のSKU形式を確認してください。');
        parts[1] = purchaser.code + assignedDeliverer.code;
        assignedReturnSku = parts.join('-');
      }

      const payload: ItemInsert = {
        ...((isAmazonReturn || isWorkingAmazonReturn) && assignedReturnSku ? { sku: assignedReturnSku } : {}),
        ...(isAmazonReturn ? { status: 'Amazon返品' as const } : {}),
        lot_seq: lotSeq === '' ? undefined : Number(lotSeq),
        is_accessory: !isAmazonReturn && !isWorkingAmazonReturn && workStream === '付属品',
        purchaser_id: purchaserId,
        deliverer_id: delivererId || null,
        work_stream: workStream || null,
        purchased_at: purchasedAt,
        title: title.trim(),
        cost_amount: Number(cost),
        marketplace,
        marketplace_item_id: generatedReference?.itemId ?? (marketplaceItemId.trim() || null),
        marketplace_url: marketplaceUrl.trim() || null,
        tracking_no: trackingNo.trim() || null,
        card_id: cardId || null,
        product_id: isWorkingAmazonReturn ? null : productId || null,
        asin: asin.trim() || null,
        condition: condition || null,
        planned_price: plannedPrice === '' ? null : Number(plannedPrice),
        planned_payout: plannedPayout === '' ? null : Number(plannedPayout),
        sales_channel: salesChannel,
        memo: note || null,
        ...(draft ? { source_purchase_draft_id: draft.id } : {}),
      };

      const created = await createItem(payload);
      if (spareId) {
        const { error: spareError } = await getSupabase().rpc('allocate_spare_accessory', { p_spare_id: spareId, p_item_id: created.id });
        if (spareError) throw new Error(`在庫 ${created.sku} は登録しましたが、予備の割り当てに失敗しました：${spareError.message}`);
        setSpares(current => current.filter(row => row.id !== spareId));
        setSpareId('');
      }
      setDone(`登録しました: ${created.sku}`);
      // 続けて同じ商品の仕入れを登録できるよう、通番号と担当者は残す
      setTitle(''); setAsin(''); setProductSearch(''); setCost(''); setMarketplaceItemId(''); setTrackingNo(''); setUrlOverride(null);
      if (isAmazonReturn || isWorkingAmazonReturn) { setLotSeq(''); setReturnSku(null); setReturnLookup(''); }
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
      <h2>在庫登録</h2>

      {done && <div className="ok">{done}</div>}
      {error && <div className="error">{error}</div>}

      <form onSubmit={submit}>
        <div className="card">
          <div className="grid cols2">
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
              <label className="field"><span>商品ID</span>
                <input type="text" value={marketplaceItemId} onChange={(e) => changeItemId(e.target.value)} />
              </label>
              <label className="field"><span>追跡番号</span>
                <input type="text" value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} />
              </label>
              <label className="field"><span>仕入先URL</span>
                <input type="url" value={marketplaceUrl} onChange={(e) => changePurchaseUrl(e.target.value)} />
              </label>
            </div>
            {marketplaceItemId.trim() && !generatedReference && !marketplaceUrl && <p className="sub" role="status">商品IDの形式を確認するか、仕入先URLを直接貼り付けてください。ラクマは商品URL末尾の32文字のIDを使います。</p>}
          <div>
            {!isWorkingAmazonReturn && <label className="field"><span>商品リスト検索</span>
                <input type="search" value={productSearch} onChange={e => { setProductSearch(e.target.value); setProductId(''); }} placeholder="ASINまたは型番" />
              </label>}
            {!isWorkingAmazonReturn && matchingProducts.length > 0 && <div className="product-search-results" role="listbox" aria-label="一致した商品">
              {matchingProducts.slice(0, 20).map(p => <button type="button" role="option" aria-selected={productId === p.id} key={p.id} onClick={() => { setProductId(p.id); setProductSearch(`${p.model_no ?? ''} / ${p.asin ?? ''}`); }}>
                {p.model_no ?? '型番なし'} / {p.asin ?? 'ASINなし'} / 目標 {p.target_cost ? yen(p.target_cost) : '—'}
              </button>)}
            </div>}
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 8 }}>
              <label className="field"><span>型番</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
              </label>
              <label className="field"><span>ASIN</span>
                <input type="text" value={asin} onChange={(e) => setAsin(e.target.value)} />
              </label>
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
          <div>
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
              <label className="field"><span>{isAmazonReturn || isWorkingAmazonReturn ? '元商品の通番号' : '通番号'}</span>
                <input type="number" min={1} value={lotSeq} onChange={(e) => setLotSeq(e.target.value === '' ? '' : Number(e.target.value))} />
              </label>
              {(isAmazonReturn || isWorkingAmazonReturn) && <p className="sub" role="status" style={{ gridColumn: '1 / -1', margin: 0 }}>{returnLookup || '元商品の通番号を入力すると、商品情報を読み込みます。'}</p>}
              <label className="field"><span>使用する予備付属品</span>
                <select value={spareId} size={6} onChange={e => setSpareId(e.target.value)}>
                  <option value="">使用しない</option>
                  {availableSpares.map(row => <option key={row.id} value={row.id}>{row.title} ／ {row.owner_name || '担当未設定'} ／ {row.source_sku || row.marketplace_item_id || `シート${row.source_sheet_row}行`}</option>)}
                </select>
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
        </div>
        <button className="btn primary" style={{ marginTop: 16, width: '100%' }} disabled={busy}>{busy ? '登録中…' : '登録する'}</button>
      </form>
    </>
  );
}
