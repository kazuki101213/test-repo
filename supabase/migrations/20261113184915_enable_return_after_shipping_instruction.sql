-- A direct return instruction is also authorization to use the return buttons.
create function app.is_supplier_return_instruction(p_body text)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select replace(p_body, chr(13), '') ~
    '(?n)^[[:blank:]]*(返送|返品)(を)?[[:blank:]]*(お願いします|お願いいたします|してください)[。！!]?[[:blank:]]*$';
$$;
revoke all on function app.is_supplier_return_instruction(text) from public, anon, authenticated;

do $migration$
declare
  definition text := pg_get_functiondef('app.apply_malfunction_reply()'::regprocedure);
  anchor text := 'if new.task_kind=''仕入先確認'' then';
begin
  if strpos(definition, anchor) = 0 then
    raise exception 'Supplier contact branch not found';
  end if;
  execute replace(definition, anchor, $branch$
 if new.task_kind='仕入先確認'
   or (new.task_kind is null and app.is_supplier_return_instruction(new.body)
     and exists (
       select 1 from app.items i join app.staff s on s.id=new.author_id and s.is_active
       where i.id=new.item_id and i.status='動作不良'
         and (i.malfunction_reported_at is null or new.created_at>=i.malfunction_reported_at)
     )) then$branch$);
end $migration$;

-- Use the date of the original instruction for open reports that already have one.
with instructed as (
  select i.id, min(c.created_at) as instructed_at
  from app.items i
  join app.item_comments c on c.item_id=i.id and c.created_at>=i.malfunction_reported_at
  join app.staff s on s.id=c.author_id and (s.role='admin' or (s.role='purchaser' and s.id=i.purchaser_id))
  where i.status='動作不良' and i.sold_on is null and i.supplier_contact_requested_at is null
    and c.task_kind is null and app.is_supplier_return_instruction(c.body)
  group by i.id
)
update app.items i set supplier_contact_requested_at=instructed.instructed_at
from instructed
where i.id=instructed.id and i.status='動作不良' and i.sold_on is null
  and i.supplier_contact_requested_at is null;
