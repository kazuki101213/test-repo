-- 販売確認（2時間ごとの販売巡回）が止まったことを管理者へプッシュ通知する（2026-11-20）。
-- 2339がメルカリで売れても、巡回が止まっていたため取引中・LINE発送依頼へ進まなかった。
-- 拡張機能のエラーはChrome内の記録とアイコンの「!」だけで、気付けなかったのが再発の原因。
-- 既存の売上通知と同じ通知経路（record_sale_notice）を使い、同じアカウント・同じ理由は1日1回だけ送る。
create or replace function app.extension_report_sales_check_problem(p_account_id text, p_reason text)
returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare
  label text;
  reason text := left(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), 120);
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '管理者認証が必要です' using errcode = '42501';
  end if;
  label := case p_account_id
    when 'mercari-1' then 'メルカリ1' when 'mercari-2' then 'メルカリ2'
    when 'auctions-1' then 'ヤフオク1' when 'auctions-2' then 'ヤフオク2'
  end;
  if label is null or reason = '' then
    raise exception '販売確認の報告内容が不正です' using errcode = '22023';
  end if;
  return app.record_sale_notice(
    jsonb_build_array('sales-check-problem', p_account_id,
      ((now() at time zone 'Asia/Tokyo')::date)::text, md5(reason))::text,
    null,
    label || 'の販売確認が止まっています。売れた商品が取引中・LINE発送依頼に進みません｜' || reason);
end
$function$;

revoke all on function app.extension_report_sales_check_problem(text, text) from public, anon;
grant execute on function app.extension_report_sales_check_problem(text, text) to authenticated;
notify pgrst, 'reload schema';
