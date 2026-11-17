-- Align management's inspection reminders with the purchase sites that support
-- the app's receipt evaluation workflow. Keep the existing Yahoo store check.
do $migration$
declare
  definition text := pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  updated text;
begin
  updated := replace(definition,
    $old$where t.kind='inspection'
      and not (i.marketplace = 'ヤフオク' and ($old$,
    $new$where t.kind='inspection'
      and app.receipt_purchase_market(i.marketplace) in ('メルカリ', 'ヤフオク', 'Yahoo!フリマ', 'ラクマ')
      and not (i.marketplace = 'ヤフオク' and ($new$);
  if updated = definition then
    raise exception 'Admin inspection snapshot source or Yahoo store check not found';
  end if;
  execute updated;
end $migration$;
notify pgrst, 'reload schema';
