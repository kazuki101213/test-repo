-- 管理アプリの入金照合（amazon-payments の reconcile）は service_role で app.apply_amazon_sale /
-- app.apply_amazon_refund を呼ぶが、service_role には app.items の更新権限がないため
-- 「permission denied for table items」で毎回失敗していた（2026-11-28 判明）。
-- 両関数は内部で管理者確認をしており、実行できるのは service_role だけなので、
-- 関数の所有者権限で動かす（SECURITY DEFINER）。search_path は '' のまま。
alter function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) security definer;
alter function app.apply_amazon_refund(text,text,text,uuid) security definer;
revoke all on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) from public, anon, authenticated;
revoke all on function app.apply_amazon_refund(text,text,text,uuid) from public, anon, authenticated;
grant execute on function app.apply_amazon_sale(text,text,text,text,date,bigint,bigint,uuid) to service_role;
grant execute on function app.apply_amazon_refund(text,text,text,uuid) to service_role;
