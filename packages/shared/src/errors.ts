/**
 * Supabase から返る失敗は 2 種類あって、型が違う。
 *   - AuthError      … Error を継承している
 *   - PostgrestError … ただのオブジェクト（message / details / hint / code）
 * 後者は `instanceof Error` が false なので、素朴に String() すると
 * 画面に「[object Object]」とだけ出て原因が分からなくなる。
 */
export function errorMessage(e: unknown): string {
  if (e === null || e === undefined) return '不明なエラーが発生しました。';
  if (typeof e === 'string') return e;

  if (e instanceof Error && e.message) return withHint(e.message, e.message);

  if (typeof e === 'object') {
    const o = e as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [o.message, o.details, o.hint].filter(Boolean) as string[];
    if (parts.length > 0) {
      const text = parts.join(' / ') + (o.code ? `（コード ${o.code}）` : '');
      return withHint(text, [o.message, o.hint].filter(Boolean).join(' '));
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* 循環参照などで文字列化できない場合は下の String() に任せる */
    }
  }
  return String(e);
}

/** よくある原因は、何をすればよいかまで書く */
function withHint(text: string, probe: string): string {
  const s = probe.toLowerCase();

  if (s.includes('schema must be one of') || s.includes('does not exist in the schema cache')
      || s.includes('the schema must be')) {
    return `${text}\n\n`
      + '【対処】Supabase のダッシュボードで Settings → API → Exposed schemas に '
      + '「app」を追加して保存してください。追加後すぐ反映されます（再デプロイは不要です）。';
  }
  if (s.includes('invalid login credentials')) {
    return 'メールアドレスかパスワードが違います。\n\n'
      + '【対処】Supabase の Authentication → Users から、'
      + '対象のユーザーの「…」メニューでパスワードを再設定できます。';
  }
  if (s.includes('email not confirmed')) {
    return 'メールアドレスの確認が済んでいません。\n\n'
      + '【対処】Supabase の Authentication → Users でユーザーを作り直し、'
      + '「Auto Confirm User」をオンにしてください。';
  }
  if (s.includes('failed to fetch') || s.includes('networkerror')) {
    return `${text}\n\n`
      + '【対処】接続先の URL が正しいか、Vercel の環境変数 VITE_SUPABASE_URL を確認してください。';
  }
  return text;
}
