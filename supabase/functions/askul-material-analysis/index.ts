import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function parseAnalysis(raw: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RequestError(400, '集計データの形式が不正です。'); }
  const input = value as { rows?: unknown; bubbleWrap?: unknown } | null;
  const rows = input?.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 30) {
    throw new RequestError(400, '1〜30行の集計データが必要です。');
  }
  const purchases = rows.map((entry, index) => {
    const row = entry?.row;
    const quantity = entry?.quantity;
    const amount = entry?.amount;
    const averageQuantity = entry?.averageQuantity;
    const comparisonMonths = entry?.comparisonMonths;
    const increased = entry?.increased;
    if (row !== index + 1 || !Number.isSafeInteger(quantity) || !Number.isSafeInteger(amount)
        || (averageQuantity !== null && (!Number.isFinite(averageQuantity) || averageQuantity <= 0))
        || !Number.isInteger(comparisonMonths) || comparisonMonths < 0 || comparisonMonths > 3
        || (averageQuantity !== null && comparisonMonths < 2) || typeof increased !== 'boolean'
        || (increased && (averageQuantity === null || quantity <= averageQuantity))) {
      throw new RequestError(400, '集計データの内容が不正です。');
    }
    const purchase = { row, quantity, amount, averageQuantity, comparisonMonths, increased };
    const { completedItems, quantityPerItem, peerQuantityPerItem, peerCount, abovePeers } = entry;
    if ([completedItems, quantityPerItem, peerQuantityPerItem, peerCount, abovePeers].every(value => value === undefined)) {
      return purchase;
    }
    const expectedRate = completedItems > 0 && quantity > 0 ? quantity / completedItems : null;
    if (!Number.isSafeInteger(completedItems) || completedItems < 0 || quantityPerItem !== expectedRate
        || !Number.isSafeInteger(peerCount) || peerCount < 0 || typeof abovePeers !== 'boolean'
        || (peerCount === 0 ? peerQuantityPerItem !== null : quantityPerItem === null
          || !Number.isFinite(peerQuantityPerItem) || peerQuantityPerItem <= 0)
        || (abovePeers && (!peerCount || quantityPerItem <= peerQuantityPerItem))) {
      throw new RequestError(400, '作業件数の比較データが不正です。');
    }
    return { ...purchase, completedItems, quantityPerItem, peerQuantityPerItem, peerCount, abovePeers };
  });
  const bubbleWrap = input?.bubbleWrap ?? [];
  if (!Array.isArray(bubbleWrap) || bubbleWrap.length > 30) throw new RequestError(400, 'プチプチの集計データが不正です。');
  const estimates = bubbleWrap.map(entry => {
    const { recorderItems, estimatedMetres, purchasedMetres } = entry ?? {};
    if (!Number.isSafeInteger(recorderItems) || recorderItems < 0 || estimatedMetres !== recorderItems * 4
        || !Number.isFinite(purchasedMetres)) throw new RequestError(400, 'プチプチの集計データが不正です。');
    return { recorderItems, estimatedMetres, purchasedMetres };
  });
  return { purchases, bubbleWrap: estimates };
}

const analysisSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    notes: { type: 'ARRAY', maxItems: 8, items: { type: 'OBJECT', properties: {
      row: { type: 'INTEGER' }, reason: { type: 'STRING' },
    }, required: ['row', 'reason'] } },
  },
  required: ['summary', 'notes'],
};

export async function handler(request: Request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json(405, { error: 'POSTのみ利用できます。' });
  try {
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) throw new RequestError(401, 'ログインが必要です。');
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      db: { schema: 'app' },
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: auth, error: authError } = await client.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (authError || !auth.user) throw new RequestError(401, 'ログインが無効です。');
    const { data: admin, error: adminError } = await client.rpc('is_admin');
    if (adminError || admin !== true) throw new RequestError(403, '管理者権限が必要です。');
    if (Number(request.headers.get('content-length') ?? 0) > 16384) throw new RequestError(400, '集計データが大きすぎます。');
    const raw = await request.text();
    if (raw.length > 16384) throw new RequestError(400, '集計データが大きすぎます。');
    const analysis = parseAnalysis(raw);
    const key = Deno.env.get('GEMINI_API_KEY');
    const model = Deno.env.get('GEMINI_MATERIALS_MODEL') || Deno.env.get('GEMINI_KEYWORDS_MODEL') || 'gemini-3.5-flash-lite';
    if (!key || !/^gemini-[a-z0-9.-]+$/.test(model)) throw new RequestError(503, 'Geminiの接続設定を確認してください。');

    // Only validated numeric aggregates and local row numbers are sent to Gemini.
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: '資材の購入集計を日本語で短く説明します。purchasesのquantityは購入数量、amountは税込円、averageQuantityは過去の月間平均購入量、increasedはその比較での目安超過です。quantityPerItemは作業完了1件あたりの購入量、peerQuantityPerItemは同月同資材を購入した他の担当者の作業件数で加重した値、peerCountはその人数です。abovePeersがtrueの行を優先し、比較人数が少ない場合は明記してください。bubbleWrapは独立した集計で、estimatedMetresはレコーダー1台あたり4mの目安、purchasedMetresは月間購入の長さです。購入時期や在庫、他の商品に使う分で差が出ます。bubbleWrapの各要素をpurchasesの行に結びつけないでください。実消費や購入理由、無駄遣い、担当者の評価を推測しないでください。nullは比較データ不足です。入力にない数値や行番号を作らないでください。summaryは500文字以内、notesは最大8件、各reasonは150文字以内です。notesにはpurchasesで説明が必要な行番号だけを返してください。' }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(analysis) }] }],
        generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json', responseSchema: analysisSchema },
      }),
    });
    if (!response.ok) throw new RequestError(response.status === 429 ? 429 : 502,
      response.status === 429 ? 'Geminiの利用上限に達しました。時間をおいて再度お試しください。' : 'Geminiの分析に失敗しました。');
    const candidate = (await response.json()).candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new RequestError(502, 'Geminiの分析結果が不完全です。');
    const result = JSON.parse(candidate.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('') ?? '');
    if (typeof result?.summary !== 'string' || !result.summary.trim() || result.summary.length > 500
        || !Array.isArray(result.notes) || result.notes.length > 8) {
      throw new RequestError(502, 'Geminiの分析結果の形式を確認できません。');
    }
    const seen = new Set<number>();
    const notes = result.notes.map((note: { row?: unknown; reason?: unknown }) => {
      if (typeof note?.row !== 'number' || !Number.isInteger(note.row) || note.row < 1 || note.row > analysis.purchases.length
          || seen.has(note.row) || typeof note.reason !== 'string' || !note.reason.trim() || note.reason.length > 150) {
        throw new RequestError(502, 'Geminiの分析結果の形式を確認できません。');
      }
      seen.add(note.row);
      return { row: note.row, reason: note.reason.trim() };
    });
    return json(200, { summary: result.summary.trim(), notes });
  } catch (error) {
    return json(error instanceof RequestError ? error.status : 502, {
      error: error instanceof RequestError ? error.message : 'Geminiの分析を取得できませんでした。',
    });
  }
}

if (import.meta.main) Deno.serve(handler);
