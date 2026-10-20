-- Remind administrators only when an approved product remains unlisted.
do $migration$
declare original text;patched text;
begin
 select pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure) into original;
 patched:=replace(original,
  $old$r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク') and i.status='商品登録前' and i.sold_on is null$old$,
  $new$r.approved_at is not null and i.sales_channel in ('メルカリ','ヤフオク','自己発送','FBA') and r.approved_at<=now()-case when i.sales_channel='FBA' then interval '120 hours' else interval '24 hours' end and i.status='商品登録前' and i.sold_on is null$new$);
 if patched=original then raise exception 'Listing task source changed; review before applying';end if;
 execute patched;
end $migration$;
