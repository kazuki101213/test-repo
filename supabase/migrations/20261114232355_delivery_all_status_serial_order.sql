-- The delivery "all statuses" view requests serial order. Sort groups before
-- applying the page limit, and use the same order to build the response.
do $migration$
declare
  definition text := pg_get_functiondef('app.read_inventory_page(text,jsonb,integer,jsonb)'::regprocedure);
  old_order constant text := 'case when $1=''delivery'' then purchased end desc nulls last';
  new_order constant text := 'case when $1=''delivery'' and ($2->>''sort'') is distinct from ''serial'' then purchased end desc nulls last';
begin
  if (length(definition) - length(replace(definition, old_order, ''))) / length(old_order) <> 2 then
    raise exception 'Expected two inventory purchase-date sort expressions';
  end if;
  execute replace(definition, old_order, new_order);
end $migration$;
