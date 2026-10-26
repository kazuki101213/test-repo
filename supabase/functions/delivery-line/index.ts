import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { deliveryOrigin, friendUrl, hashCode, linkCode, validSignature, shippingMessages, dispatchState } from './validation.ts';
import type { ShippingPayload } from './validation.ts';
import QRCode from 'npm:qrcode@1.5.4';
import { prepareShippingMedia } from './media.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false },
});
const accessToken = () => Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN');
const channelSecret = () => Deno.env.get('LINE_CHANNEL_SECRET');
const officialUrl = () => friendUrl(Deno.env.get('LINE_OFFICIAL_ACCOUNT_URL'));
const ready = () => !!(accessToken() && channelSecret());
async function botConnection() {
  const configured = ready();
  if (!configured) return { configured, verified: false, tokenConfigured: !!accessToken(), secretConfigured: !!channelSecret(), officialUrl: null, displayName: null };
  const result = await fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${accessToken()}` }, signal: AbortSignal.timeout(8000) });
  if (!result.ok) return { configured, verified: false, tokenConfigured: true, secretConfigured: true, officialUrl: null, displayName: null, status: result.status };
  const info = await result.json();
  const url = officialUrl() || (typeof info.basicId === 'string' && /^@[a-zA-Z0-9._-]+$/.test(info.basicId) ? `https://line.me/R/ti/p/${encodeURIComponent(info.basicId)}` : null);
  return { configured, verified: !!url, tokenConfigured: true, secretConfigured: true, officialUrl: url, displayName: typeof info.displayName === 'string' ? info.displayName : null };
}
// Enable only after the three-image preparation pipeline has been verified.
const shippingEnabled = async () => {
  if (!ready()) return false;
  const { data, error } = await admin.from('delivery_line_settings').select('enabled').eq('singleton', true).maybeSingle();
  if (error) throw error;
  return data?.enabled === true;
};
function response(status: number, value: unknown, origin: string | null = null) {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'Access-Control-Allow-Origin': origin === deliveryOrigin ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
}
async function rpc(name: string, params: Record<string, unknown> = {}) {
  const result = await admin.rpc(name, params);
  if (result.error) throw result.error;
  return result.data;
}
async function cleanupCodeImages() {
  // Event-based, bounded cleanup. Product photos and deduplication IDs remain.
  const {data,error} = await admin.from('delivery_line_outbox').select('id').in('state',['sent','cancelled','failed']).is('code_cleaned_at',null).lt('next_attempt_at',new Date(Date.now()-8*86400000).toISOString()).limit(20);
  if (error || !data?.length) return;
  const removed = await admin.storage.from('line-shipping-codes').remove(data.map(row => `${row.id}.png`));
  if (!removed.error) await admin.from('delivery_line_outbox').update({code_cleaned_at:new Date().toISOString(),message_payload:null}).in('id',data.map(row => row.id));
}
async function webhook(req: Request) {
  const raw = await req.text();
  if (raw.length > 262144) return response(413, {});
  if (!await validSignature(raw, req.headers.get('x-line-signature'), channelSecret() || '')) return response(401, {});
  const body = JSON.parse(raw);
  if (!Array.isArray(body.events) || body.events.length > 100) return response(400, {});
  for (const event of body.events) {
    if (event.source?.type !== 'user' || !/^U[0-9a-f]{32}$/.test(event.source.userId || '') || typeof event.webhookEventId !== 'string' || !event.webhookEventId || event.webhookEventId.length > 128) continue;
    if (!Number.isFinite(event.timestamp) || Math.abs(Date.now() - event.timestamp) > 86400000) continue;
    if (event.type === 'unfollow') {
      await rpc('handle_delivery_line_event', { p_event: event.webhookEventId, p_kind: 'unfollow', p_user: event.source.userId });
    } else if (event.type === 'message' && event.message?.type === 'text') {
      const code = linkCode(event.message.text);
      if (!code) continue;
      const linked = await rpc('handle_delivery_line_event', { p_event: event.webhookEventId, p_kind: 'link', p_user: event.source.userId, p_hash: await hashCode(code) });
      // Only confirm successful, first-time consumption. The app remains the
      // source of truth if LINE's reply API times out; no duplicate push fallback.
      if (linked && accessToken() && typeof event.replyToken === 'string') {
        try {
          await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', signal: AbortSignal.timeout(8000), headers: {
            Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json',
          }, body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text: '納品担当者との連携が完了しました。納品アプリの通知設定で確認できます。' }] }) });
        } catch { /* Linking has committed. Do not replay or log private payloads. */ }
      }
    }
  }
  return response(200, {});
}
Deno.serve(async req => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return response(origin === deliveryOrigin ? 204 : 403, {}, origin);
  if (req.method !== 'POST') return response(405, {});
  try {
    // This public route is authenticated using LINE's signature, not user JWTs.
    if (new URL(req.url).pathname.endsWith('/webhook')) return await webhook(req);
    const body = await req.json();
    if (body.action === 'dispatch' || body.action === 'connection') {
      const config = await rpc('delivery_push_config');
      if (!req.headers.get('x-delivery-dispatch') || req.headers.get('x-delivery-dispatch') !== config.delivery_push_dispatch_token) return response(401, {});
      if (body.action === 'connection') return response(200, await botConnection());
      if (!await shippingEnabled()) return response(200, { configured: false, processed: 0 });
      const rows = await rpc('claim_delivery_line');
      let sent = 0;
      for (const row of rows || []) {
        let state = 'cancelled', status: number | null = null;
        if (row.eligible) {
          // Initial notices are explicitly marked by the queue. Media deliveries
          // still require their complete current-trade bundle.
          try {
            const payload = row.payload.media ? {...await prepareShippingMedia({ admin, media: row.payload.media, deliveryId: row.id, QRCode }),...(row.payload.imageFollowup ? {imageFollowup:true} : {})} : row.payload as ShippingPayload;
            const messages = shippingMessages(payload);
            // Recheck the current trade and assignee before the LINE request.
            if (!await rpc('prepare_delivery_line_message', { p_id: row.id, p_lease: row.lease, p_messages: payload })) {
              await rpc('finish_delivery_line', { p_id: row.id, p_lease: row.lease, p_state: 'cancelled', p_status: null });
              continue;
            }
            try {
              const result = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', signal: AbortSignal.timeout(8000), headers: {
                Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': payload.deliveryRetryKey || row.id,
              }, body: JSON.stringify({ to: row.recipient, messages }) });
              status = result.status; state = dispatchState(status);
            } catch { state = 'pending'; }
          } catch { state = 'failed'; }
        }
        if (state === 'sent') sent++;
        await rpc('finish_delivery_line', { p_id: row.id, p_lease: row.lease, p_state: state, p_status: status });
      }
      if (rows.length === 2) await rpc('kick_delivery_line');
      await cleanupCodeImages().catch(() => {});
      return response(200, { processed: rows.length, sent });
    }
    if (origin !== deliveryOrigin) return response(403, {});
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return response(401, {}, origin);
    const { data: user, error: authError } = await admin.auth.getUser(token);
    if (authError || !user.user) return response(401, {}, origin);
    const profile = await admin.from('profiles').select('staff_id').eq('user_id', user.user.id).maybeSingle();
    if (profile.error) throw profile.error;
    const staff = await admin.from('staff').select('id,role,is_active').eq('id', profile.data?.staff_id || '').maybeSingle();
    if (staff.error) throw staff.error;
    if (!staff.data?.is_active || !['admin','deliverer'].includes(staff.data.role)) return response(403, {}, origin);
    const staffId = staff.data.id;
    if (body.action === 'status') {
      const connection = await botConnection();
      const link = await admin.from('delivery_line_links').select('linked_at,blocked').eq('staff_id', staffId).maybeSingle();
      if (link.error) throw link.error;
      return response(200, { configured: connection.verified, officialUrl: connection.officialUrl, linked: !!link.data, blocked: link.data?.blocked ?? false, shippingEnabled: await shippingEnabled() }, origin);
    }
    if (body.action === 'issue') {
      if (!ready()) return response(503, { error: 'LINE公式アカウントの接続設定が必要です。' }, origin);
      const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      try { await rpc('issue_delivery_line_code', { p_staff: staffId, p_hash: await hashCode(code) }); }
      catch { return response(429, { error: '少し待ってから再度お試しください。' }, origin); }
      return response(200, { message: `連携 ${code}`, expiresAt: new Date(Date.now() + 600000).toISOString() }, origin);
    }
    if (body.action === 'unlink') {
      await rpc('unlink_delivery_line', { p_staff: staffId });
      return response(200, { unlinked: true }, origin);
    }
    return response(400, {}, origin);
  } catch {
    console.error('delivery-line request failed'); // No tokens, codes, LINE IDs or images.
    return response(500, { error: 'LINE連携の処理に失敗しました。再度お試しください。' }, origin);
  }
});
