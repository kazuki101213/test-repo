import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const allowedOrigins = new Set([
  'https://kazuki101213.github.io',
  'https://bussan-admin.vercel.app',
  'https://test-repo-delivery.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174',
]);

function response(status: number, body: unknown, origin: string | null) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': origin ?? 'null',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    },
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return response(403, { error: '許可されていないアクセス元です。' }, null);
    return response(204, {}, origin);
  }
  if (req.method !== 'POST') return response(405, { error: 'POST のみ受け付けます。' }, origin);
  if (!origin || !allowedOrigins.has(origin)) return response(403, { error: '許可されていないアクセス元です。' }, null);

  try {
    const payload = await req.json();
    const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response(400, { error: 'メールアドレスを確認してください。' }, origin);
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) return response(503, { error: 'ログイン設定が未完了です。' }, origin);

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'app' },
    });

    // Only emails linked to an active staff profile can be selected.
    const { data: staffRows, error: staffError } = await admin
      .from('staff')
      .select('id,email,is_active')
      .eq('is_active', true);
    if (staffError) throw staffError;
    const staff = (staffRows ?? []).find((row) => row.email?.trim().toLowerCase() === email);
    if (!staff) return response(403, { error: '登録済みの担当者メールアドレスを確認してください。' }, origin);

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('user_id')
      .eq('staff_id', staff.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return response(403, { error: 'この担当者はログイン設定がありません。' }, origin);

    const { data: authUser, error: userError } = await admin.auth.admin.getUserById(profile.user_id);
    if (userError || !authUser.user?.email) return response(403, { error: 'この担当者のログイン設定を確認してください。' }, origin);

    // Deliberately skip mailbox verification: the user chose email-only login.
    // Generate and immediately redeem a one-time Supabase token server-side.
    const { data: generated, error: generateError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: authUser.user.email,
      options: { redirectTo: origin },
    });
    if (generateError) throw generateError;
    const tokenHash = generated.properties?.hashed_token;
    if (!tokenHash) throw new Error('認証トークンを作成できませんでした。');

    const { data: verified, error: verifyError } = await admin.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    });
    if (verifyError) throw verifyError;
    if (!verified.session?.access_token || !verified.session.refresh_token) {
      throw new Error('ログインセッションを作成できませんでした。');
    }

    return response(200, {
      session: {
        access_token: verified.session.access_token,
        refresh_token: verified.session.refresh_token,
      },
    }, origin);
  } catch (error) {
    console.error('email-only-login failed', error instanceof Error ? error.message : 'unknown error');
    return response(500, { error: 'ログインに失敗しました。時間をおいてもう一度お試しください。' }, origin);
  }
});
