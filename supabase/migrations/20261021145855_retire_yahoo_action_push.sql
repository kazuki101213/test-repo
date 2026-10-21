-- Yahoo workflow instructions remain comments, but their former admin action
-- task was merged into the approval/age-based listing task. Match the UI filter.
do $migration$
declare original text;patched text;
begin
 original:=pg_get_functiondef('app.capture_admin_push()'::regprocedure);
 patched:=replace(original,
  $old$new.task_kind<>'仕入先確認' and new.task_completed_at is null$old$,
  $new$new.task_kind<>'仕入先確認' and new.task_kind not like '%ヤフオク%' and new.task_completed_at is null$new$);
 if patched=original and position($guard$new.task_kind not like '%ヤフオク%'$guard$ in original)=0 then
  raise exception 'Admin action capture changed; review exclusion';
 end if;
 execute patched;
 original:=pg_get_functiondef('app.claim_admin_push()'::regprocedure);
 patched:=replace(original,
  $old$c.task_kind<>'仕入先確認' and c.task_completed_at is null$old$,
  $new$c.task_kind<>'仕入先確認' and c.task_kind not like '%ヤフオク%' and c.task_completed_at is null$new$);
 if patched=original and position($guard$c.task_kind not like '%ヤフオク%'$guard$ in original)=0 then
  raise exception 'Admin action dispatch changed; review exclusion';
 end if;
 execute patched;
end $migration$;

-- Preserve the instruction, its completion state, and sent notification history.
-- Stop retries already queued by the retired task, including in-flight retries.
update app.admin_push_deliveries d set state='cancelled'
from app.admin_push_events e,app.item_comments c
where d.event_id=e.id and e.kind='action' and e.source_id=c.id
 and c.task_kind like '%ヤフオク%' and d.state in ('pending','sending');

notify pgrst,'reload schema';
