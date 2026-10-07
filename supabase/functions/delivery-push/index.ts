import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { ApplicationServer, exportApplicationServerKey, exportVapidKeys, generateVapidKeys, importVapidKeys, PushMessageError } from 'jsr:@negrel/webpush@0.5.0';
import { validSubscription, notificationBody } from './validation.ts';

const baseUrls = new Set(['https://test-repo-delivery.vercel.app/', 'https://kazuki101213.github.io/test-repo/delivery/', 'http://localhost:5174/']);
const origins = new Set([...baseUrls].map(url => new URL(url).origin));
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false },
});
function respond(status: number, value: unknown, origin: string | null) {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'Access-Control-Allow-Origin': origin && origins.has(origin) ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
}
async function config() {
  const { data, error } = await admin.rpc('delivery_push_config');
  if (error) throw error;
  return data as Record<string, string>;
}
async function sender(settings: Record<string, string>) {
  return ApplicationServer.new({
    contactInformation: 'https://test-repo-delivery.vercel.app/',
    vapidKeys: await importVapidKeys(JSON.parse(settings.delivery_push_vapid)),
  });
}

Deno.serve(async req => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return respond(origin && origins.has(origin) ? 204 : 403, {}, origin);
  if (req.method !== 'POST') return respond(405, { error: 'POST only' }, origin);
  try {
    const payload = await req.json();
    if (payload.action === 'dispatch') {
      const settings = await config();
      const token = req.headers.get('x-delivery-dispatch');
      if (!token || !settings.delivery_push_dispatch_token || token !== settings.delivery_push_dispatch_token) return respond(401, { error: 'Unauthorized' }, origin);
      const server = await sender(settings);
      const { data: rows, error } = await admin.rpc('claim_delivery_push');
      if (error) throw error;
      let sent = 0, cancelled = 0, retry = 0;
      for (const row of rows || []) {
        let state = 'cancelled', status: number | null = null;
        if (row.eligible && baseUrls.has(row.base_url) && validSubscription({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } })) {
          try {
            await server.subscribe({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }).pushTextMessage(JSON.stringify({
              body: notificationBody(row.kind, row.lot_seq), itemId: row.item_id, tag: `delivery-${row.item_id}-${row.kind}`,
            }), { ttl: 86400 });
            state = 'sent'; status = 201; sent++;
          } catch (cause) {
            status = cause instanceof PushMessageError ? cause.response.status : null;
            if (status === 404 || status === 410) {
              const result = await admin.from('delivery_push_subscriptions').update({ enabled: false, updated_at: new Date().toISOString() }).eq('id', row.subscription_id);
              if (result.error) throw result.error;
              state = 'cancelled'; cancelled++;
            } else if (status !== null && status >= 400 && status < 500 && status !== 429) { state = 'failed'; }
            else { state = 'pending'; retry++; }
          }
        } else { cancelled++; }
        const result = await admin.rpc('finish_delivery_push', { p_id: row.delivery_id, p_state: state, p_status: status });
        if (result.error) throw result.error;
      }
      return respond(200, { processed: (rows || []).length, sent, cancelled, retry }, origin);
    }
    if (!origin || !origins.has(origin)) return respond(403, { error: 'Origin denied' }, origin);
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return respond(401, { error: 'Unauthorized' }, origin);
    const { data: user, error: authError } = await admin.auth.getUser(token);
    if (authError || !user.user) return respond(401, { error: 'Unauthorized' }, origin);
    const { data: profile, error: profileError } = await admin.from('profiles').select('staff_id').eq('user_id', user.user.id).maybeSingle();
    if (profileError) throw profileError;
    const { data: staff, error: staffError } = await admin.from('staff').select('id,role,is_active').eq('id', profile?.staff_id || '').maybeSingle();
    if (staffError) throw staffError;
    if (!staff?.is_active || !['admin', 'deliverer'].includes(staff.role)) return respond(403, { error: 'Active delivery staff required' }, origin);
    if (payload.action === 'setup') {
      if (staff.role !== 'admin') return respond(403, { error: 'Admin required' }, origin);
      const keys = await generateVapidKeys({ extractable: true });
      const { error } = await admin.rpc('initialize_delivery_push', {
        p_vapid: JSON.stringify(await exportVapidKeys(keys)), p_public_key: await exportApplicationServerKey(keys), p_project_url: Deno.env.get('SUPABASE_URL'),
      });
      if (error) throw error;
      return respond(200, { initialized: true }, origin);
    }
    if (payload.action === 'config') {
      const settings = await config();
      return settings.delivery_push_public_key ? respond(200, { publicKey: settings.delivery_push_public_key }, origin) : respond(503, { error: 'Not configured' }, origin);
    }
    if (payload.action === 'status') {
      if (typeof payload.endpoint !== 'string') return respond(400, { error: 'Invalid endpoint' }, origin);
      const { data: subscription, error } = await admin.from('delivery_push_subscriptions').select('enabled').eq('endpoint', payload.endpoint).eq('staff_id', staff.id).maybeSingle();
      if (error) throw error;
      return respond(200, { enabled: subscription?.enabled ?? null }, origin);
    }
    if (payload.action === 'subscribe') {
      if (!validSubscription(payload.subscription) || !baseUrls.has(payload.baseUrl) || new URL(payload.baseUrl).origin !== origin) return respond(400, { error: 'Invalid subscription' }, origin);
      // Validate that the client key is actually a point on P-256 before storing it.
      const rawKey = Uint8Array.from(atob(payload.subscription.keys.p256dh.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      try { await crypto.subtle.importKey('raw', rawKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
      catch { return respond(400, { error: 'Invalid subscription key' }, origin); }
      const { data: old, error: oldError } = await admin.from('delivery_push_subscriptions').select('staff_id,enabled,created_at').eq('endpoint', payload.subscription.endpoint).maybeSingle();
      if (oldError) throw oldError;
      const now = new Date().toISOString();
      const { error } = await admin.from('delivery_push_subscriptions').upsert({
        endpoint: payload.subscription.endpoint, staff_id: staff.id, p256dh: payload.subscription.keys.p256dh, auth: payload.subscription.keys.auth,
        base_url: payload.baseUrl, enabled: true, updated_at: now,
        created_at: old && old.staff_id === staff.id && old.enabled ? old.created_at : now,
      }, { onConflict: 'endpoint' });
      if (error) throw error;
      return respond(200, { subscribed: true }, origin);
    }
    if (payload.action === 'unsubscribe') {
      if (typeof payload.endpoint !== 'string') return respond(400, { error: 'Invalid endpoint' }, origin);
      const { error } = await admin.from('delivery_push_subscriptions').update({ enabled: false, updated_at: new Date().toISOString() }).eq('endpoint', payload.endpoint).eq('staff_id', staff.id);
      if (error) throw error;
      return respond(200, { unsubscribed: true }, origin);
    }
    if (payload.action === 'test') {
      const { data: subscription, error } = await admin.from('delivery_push_subscriptions').select('endpoint,p256dh,auth').eq('endpoint', payload.endpoint).eq('staff_id', staff.id).eq('enabled', true).maybeSingle();
      if (error) throw error;
      if (!subscription) return respond(404, { error: 'Subscription not found' }, origin);
      const server = await sender(await config());
      await server.subscribe({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }).pushTextMessage(JSON.stringify({ body: '通知のテストです。新しいタスクもこのように届きます。', tag: 'delivery-test' }), { ttl: 300 });
      return respond(200, { sent: true }, origin);
    }
    return respond(400, { error: 'Unknown action' }, origin);
  } catch {
    // Never log subscriptions, account tokens, or Vault keys.
    console.error('delivery-push request failed');
    return respond(500, { error: '通知の処理に失敗しました。' }, origin);
  }
});
