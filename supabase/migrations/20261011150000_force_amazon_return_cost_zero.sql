create or replace function app.items_sync_status()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'app'
as $function$
begin
  if new.marketplace in ('Amazon返品', '動作品Amazon返品') then
    new.cost_amount := 0;
  end if;
  if tg_op = 'UPDATE'
     and new.status = '出品中'
     and new.status is distinct from old.status
     and new.shipped_on is not distinct from old.shipped_on then
    return new;
  end if;
  if new.status in ('返品処理', '販売済') then return new; end if;
  new.status := case when new.shipped_on is not null then '出品中' else '作業中' end;
  return new;
end;
$function$;