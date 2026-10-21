begin;
create temporary table accessory_assignment_probe(id uuid, owner_id uuid, user_id uuid);
grant select on accessory_assignment_probe to authenticated;
do $$
declare buyer uuid; owner uuid; other_owner uuid; owner_user uuid; body uuid; child uuid; explicit_child uuid; pending_body uuid; pending_child uuid; n integer;
begin
  select id into strict buyer from app.staff where code='AA';
  select s.id,p.user_id into strict owner,owner_user from app.staff s join app.profiles p on p.staff_id=s.id where s.code='DD';
  select id into strict other_owner from app.staff where code='AA';
  select coalesce(max(lot_seq),0)+100 into n from app.items;
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no)
  values(n,buyer,owner,current_date,'assignment body',100,'メルカリ','fixture') returning id into body;
  insert into app.items(lot_seq,purchaser_id,purchased_at,title,cost_amount,marketplace,is_accessory)
  values(n,buyer,current_date,'assignment remote',10,'メルカリ',true) returning id into child;
  if not exists(select 1 from app.items where id=child and parent_item_id=body and deliverer_id=owner) then raise exception 'Insert did not inherit body assignment'; end if;
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory)
  values(n,buyer,other_owner,current_date,'explicit remote',10,'メルカリ',true) returning id into explicit_child;
  if (select deliverer_id from app.items where id=explicit_child)<>other_owner then raise exception 'Explicit assignment overwritten'; end if;
  insert into app.items(lot_seq,purchaser_id,purchased_at,title,cost_amount,marketplace,tracking_no)
  values(n+1,buyer,current_date,'pending body',100,'メルカリ','fixture') returning id into pending_body;
  insert into app.items(lot_seq,purchaser_id,purchased_at,title,cost_amount,marketplace,is_accessory)
  values(n+1,buyer,current_date,'pending remote',10,'メルカリ',true) returning id into pending_child;
  update app.items set deliverer_id=owner where id=pending_body;
  if (select deliverer_id from app.items where id=pending_child) is distinct from owner then raise exception 'Late body assignment not inherited'; end if;
  insert into accessory_assignment_probe values(body,owner,owner_user),(child,owner,owner_user),(pending_child,owner,owner_user);
end $$;
set local role authenticated;
do $$declare u uuid; n integer;begin
  select user_id into strict u from accessory_assignment_probe limit 1;
  perform set_config('request.jwt.claim.sub',u::text,true);
  select count(*) into n from app.v_delivery_tasks where id in(select id from accessory_assignment_probe);
  if n<>3 then raise exception 'Assigned staff cannot see complete body/accessory group: %',n; end if;
  if exists(select 1 from app.v_delivery_tasks where deliverer_id is distinct from (select owner_id from accessory_assignment_probe limit 1)) then raise exception 'Owner isolation weakened';end if;
end $$;
reset role;
rollback;
