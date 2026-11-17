-- Keep the existing inventory column and use the assigned deliverer's latest
-- message or fault report as its value.
do $migration$
declare
  definition text := pg_get_viewdef('app.v_inventory_display'::regclass,true);
  old_comment constant text := $old$LEFT JOIN LATERAL ( SELECT item_comments.body
           FROM app.item_comments
          WHERE item_comments.item_id = inventory.id
          ORDER BY item_comments.created_at DESC, item_comments.id DESC
         LIMIT 1) latest ON true$old$;
  deliverer_comment constant text := $new$LEFT JOIN LATERAL (
       SELECT candidate.body
       FROM (
         (SELECT c.body,c.created_at,c.id
          FROM app.item_comments c
          WHERE c.item_id=inventory.id
            AND c.author_id=raw.deliverer_id
            AND c.body ~ '[^[:space:]]'
          ORDER BY c.created_at DESC,c.id DESC
          LIMIT 1)
         UNION ALL
         SELECT raw.malfunction_comment,raw.malfunction_reported_at,NULL::uuid
         WHERE raw.malfunction_reported_by=raw.deliverer_id
           AND raw.malfunction_comment ~ '[^[:space:]]'
       ) candidate
       ORDER BY candidate.created_at DESC NULLS LAST,candidate.id DESC NULLS LAST
       LIMIT 1
     ) latest ON ((select app.current_role()) in ('admin','purchaser')
                  or raw.deliverer_id=(select app.current_staff_id()))$new$;
begin
  if strpos(definition,old_comment)=0 then
    raise exception 'Inventory comment join does not match the expected definition';
  end if;
  execute 'create or replace view app.v_inventory_display as ' ||
    replace(definition,old_comment,deliverer_comment);
end $migration$;

notify pgrst,'reload schema';
