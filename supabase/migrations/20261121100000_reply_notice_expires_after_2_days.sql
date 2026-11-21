-- 納品アプリの「動作不良への返信があります。」(kind='reply'、差し戻しを含む) は、
-- 返信から2日経ったら表示しない（2026-11-21 ユーザー指定）。
do $patch$
declare
  definition text := pg_get_viewdef('app.v_delivery_notice_tasks'::regclass);
  old_where constant text := 'WHERE ((auth.uid() IS NOT NULL)';
  new_where constant text := 'WHERE (((n.kind <> ''reply''::text) OR (n.created_at > (now() - ''2 days''::interval))) AND (auth.uid() IS NOT NULL)';
  old_expires constant text := 'NULL::timestamp with time zone AS expires_at';
  new_expires constant text := 'CASE WHEN (n.kind = ''reply''::text) THEN (n.created_at + ''2 days''::interval) ELSE NULL::timestamp with time zone END AS expires_at';
begin
  if strpos(definition, old_where)=0 or strpos(definition, old_expires)=0
     or strpos(definition, '2 days')>0 then
    raise exception 'v_delivery_notice_tasks changed unexpectedly';
  end if;
  execute 'create or replace view app.v_delivery_notice_tasks with (security_invoker=true) as '
    || replace(replace(definition, old_where, new_where), old_expires, new_expires);
end
$patch$;
notify pgrst, 'reload schema';
