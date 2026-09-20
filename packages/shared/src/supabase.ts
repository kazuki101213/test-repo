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

  const { data, error } = await sb
    .from('profiles')
    .select('staff:staff_id(id, code, name, display_name, role, is_company, email, is_active)')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (error) throw error;
  const staff = (data as { staff: Staff } | null)?.staff;
  if (!staff) {
    throw new Error(
      'このアカウントにスタッフが紐付いていません。管理者に app.profiles への登録を依頼してください。',
    );
  }
  return { user: auth.user, staff };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut();
}
