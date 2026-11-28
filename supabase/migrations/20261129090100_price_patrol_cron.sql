-- 価格巡回を5分ごとに少しずつ進める（各商品は3日に1回。Keepaは1分1トークンの回復に合わせて数件ずつ）
select cron.schedule('price-patrol', '*/5 * * * *', $cmd$
  with config as (
    select (select decrypted_secret from vault.decrypted_secrets where name='delivery_push_project_url') project_url,
           (select decrypted_secret from vault.decrypted_secrets where name='amazon_daily_sync_token') token
  )
  select net.http_post(
    url := rtrim(project_url,'/') || '/functions/v1/price-patrol',
    headers := jsonb_build_object('Content-Type','application/json','x-amazon-cron-token',token),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) from config;
$cmd$);
-- KeepaのAPIキーは Vault の keepa_api_key（値はリポジトリ・ノートに書かない）
