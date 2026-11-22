-- アスクルのログインが切れたことを管理者へプッシュ通知する（2026-11-22）。
-- 週1回（月曜01:00）のアスクル経費取り込みは、DELLのChrome（Default）がアスクルにログインしている必要がある。
-- 拡張機能が毎日アスクルの画面を開いて確認し、ログイン画面に移されたらこの関数で知らせる。
-- 販売確認停止と同じ通知経路（record_sale_notice）で、1日1回だけ送る。
create or replace function app.extension_report_askul_login_required()
returns boolean
language plpgsql security definer set search_path = ''
as $function$
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  return app.record_sale_notice(
    jsonb_build_array('askul-login-required', ((now() at time zone 'Asia/Tokyo')::date)::text)::text,
    null,
    'アスクルのログインが切れています。DELLのChrome（Browser 1）でアスクルにログインしてください。月曜1時の経費取り込みが止まります。');
end
$function$;

revoke all on function app.extension_report_askul_login_required() from public, anon;
grant execute on function app.extension_report_askul_login_required() to authenticated;
notify pgrst, 'reload schema';
