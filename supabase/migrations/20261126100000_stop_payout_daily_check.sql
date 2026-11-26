-- 毎日の照合（10分ごとの定期実行）をやめる（2026-11-26 ユーザー指示：APIは登録時・販売想定金額の変更時だけ使う）。
-- 販売想定金額だけを変える保存を断る trigger は残す。
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'product-payout-daily-check') then
    perform cron.unschedule('product-payout-daily-check');
  end if;
end
$cron$;
