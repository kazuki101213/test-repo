import { createClient, type User } from '@supabase/supabase-js';
import type { Staff } from './types';

function createAppClient(url: string, key: string) {
  return createClient(url, key, {
    // テーブル・ビュー・RPC はすべて app スキーマに置いている
    db: { schema: 'app' },
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

/** app スキーマに固定した Supabase クライアント */
export type AppClient = ReturnType<typeof createAppClient>;

let client: AppClient | null = null;

/**
 * 2 つのアプリが同じ Supabase プロジェクトを見るためのクライアント。
 * schema は app 固定（config.toml で PostgREST に公開している）。
 */
export function getSupabase(): AppClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。.env.local を作成してください。',
    );
  }

  client = createAppClient(url, key);
  return client;
}

export interface Session {
  user: User;
  staff: Staff;
}

/** ログイン中のユーザーに紐づく app.staff を引く */
export async function loadSession(): Promise<Session | null> {
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return null;

  // 埋め込み取得（staff:staff_id(...)）は PostgREST の版によって
  // オブジェクトと配列のどちらで返るかが変わる。ここはログインの根幹なので、
  // 素直に 2 回引いて振る舞いを固定する。
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('staff_id')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (profileError) throw profileError;

  const staffId = (profile as { staff_id: string } | null)?.staff_id;
  if (!staffId) {
    throw new Error(
      'このアカウントは担当者に紐付いていません。'
        + '管理者に「app.link_login でこのメールアドレスを登録してほしい」と伝えてください。',
    );
  }

  const { data: staff, error: staffError } = await sb
    .from('staff')
    .select('id, code, name, display_name, role, is_company, email, is_active')
    .eq('id', staffId)
    .maybeSingle();

  if (staffError) throw staffError;
  if (!staff) throw new Error('担当者の情報が見つかりませんでした。');
  if (!(staff as Staff).is_active) {
    throw new Error('この担当者は在籍していない設定になっています。管理者に確認してください。');
  }

  return { user: auth.user, staff: staff as Staff };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut();
}
