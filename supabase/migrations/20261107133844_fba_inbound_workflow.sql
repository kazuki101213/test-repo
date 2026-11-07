create table app.fba_inbound_plans (
 id uuid primary key default gen_random_uuid(),
 account text not null check(account in ('FBA1','FBA2')),
 staff_id uuid not null references app.staff(id),
 name text not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 revision integer not null default 0,
 stage text not null default 'draft' check(stage in ('draft','created','packing-options','packing-confirmed','packed','placement-options','transport-options','placement-confirmed','ready','cancelled')),
 amazon_id text,
 pending jsonb,
 work jsonb not null default '{}'::jsonb,
 unique(account,amazon_id)
);
create index fba_inbound_staff_recent on app.fba_inbound_plans(staff_id,created_at desc);
create table app.fba_inbound_items (
 plan_id uuid not null references app.fba_inbound_plans(id) on delete cascade,
 item_id uuid not null references app.items(id) on delete restrict,
 sku text not null,
 asin text not null,
 title text not null,
 condition text not null,
 sales_channel app.sales_channel not null,
 released_at timestamptz,
 published_at timestamptz,
 primary key(plan_id,item_id),
 unique(plan_id,sku)
);
create unique index fba_inbound_reserved_item on app.fba_inbound_items(item_id) where released_at is null;
alter table app.fba_inbound_plans enable row level security;
alter table app.fba_inbound_items enable row level security;
revoke all on app.fba_inbound_plans,app.fba_inbound_items from public,anon,authenticated;
grant select,insert,update,delete on app.fba_inbound_plans,app.fba_inbound_items to service_role;

create function app.create_fba_inbound_draft(p_user uuid,p_items uuid[])
returns uuid language plpgsql set search_path='' as $$
declare
 v_actor app.staff; v_staff app.staff; v_item app.items;
 v_account text; v_channel text; v_plan uuid; v_count integer:=0;
begin
 select s.* into v_actor from app.profiles p join app.staff s on s.id=p.staff_id
 where p.user_id=p_user and s.is_active;
 if not found then raise exception '利用権限がありません。' using errcode='42501'; end if;
 if coalesce(cardinality(p_items),0) not between 1 and 100
 or cardinality(p_items)<>(select count(distinct a) from unnest(p_items) a)
 then raise exception '納品商品は1〜100点を選んでください。' using errcode='22023'; end if;
 for v_item in select i.* from app.items i where i.id=any(p_items) order by i.id for update loop
   v_count:=v_count+1;
   v_channel:=case when v_item.sales_channel::text in ('FBA','FBA1') then 'FBA1'
                   when v_item.sales_channel::text='FBA2' then 'FBA2' end;
   if v_channel is null or v_item.status::text<>'商品登録前'
     or v_item.deliverer_id is null or (v_actor.role::text<>'admin' and v_actor.id<>v_item.deliverer_id)
     or (coalesce(v_item.is_accessory,false) and v_item.sku !~* '^\d+c+[-_]')
     or nullif(v_item.sku,'') is null or coalesce(btrim(v_item.asin::text),'') !~ '^[A-Z0-9]{10}$'
     or v_item.condition is null then
      raise exception '担当者・販売先・状態・ASIN・コンディションを確認し、在庫で選び直してください。' using errcode='22023';
   end if;
   if v_plan is null then
     select s.* into v_staff from app.staff s where s.id=v_item.deliverer_id and s.is_active;
     if not found then raise exception '納品担当者を確認してください。' using errcode='22023'; end if;
     v_account:=v_channel;
     insert into app.fba_inbound_plans(account,staff_id,name,created_by)
     values(v_account,v_staff.id,left(v_staff.name,24)||to_char(now() at time zone 'Asia/Tokyo','YYYY/FMMM/FMDD'),p_user)
     returning id into v_plan;
   elsif v_account<>v_channel or v_staff.id<>v_item.deliverer_id then
     raise exception '販売先・納品担当者ごとに分けて登録してください。' using errcode='22023';
   end if;
   insert into app.fba_inbound_items(plan_id,item_id,sku,asin,title,condition,sales_channel)
   values(v_plan,v_item.id,v_item.sku,btrim(v_item.asin::text),coalesce(nullif(v_item.title,''),v_item.sku),v_item.condition::text,v_item.sales_channel);
 end loop;
 if v_count<>cardinality(p_items) then raise exception '商品を確認できません。' using errcode='22023'; end if;
 return v_plan;
exception when unique_violation then
 raise exception '別の納品に登録済みの商品があります。納品履歴を確認してください。' using errcode='23505';
end $$;

create function app.cancel_fba_inbound_plan(p_plan uuid,p_revision integer)
returns boolean language plpgsql set search_path='' as $$
begin
 update app.fba_inbound_plans set stage='cancelled',pending=null,revision=revision+1,updated_at=now()
 where id=p_plan and revision=p_revision;
 if not found then return false; end if;
 update app.fba_inbound_items set released_at=now() where plan_id=p_plan and released_at is null;
 return true;
end $$;

create function app.publish_fba_inbound_items(p_plan uuid,p_items uuid[])
returns integer language plpgsql set search_path='' as $$
declare v_count integer;
begin
 with verified as (
  update app.items i set status='出品中',product_registered_at=coalesce(i.product_registered_at,now())
  from app.fba_inbound_items f join app.fba_inbound_plans p on p.id=f.plan_id
  where p.id=p_plan and p.stage='ready' and f.released_at is null and f.published_at is null
  and i.id=f.item_id and i.id=any(p_items) and i.sku=f.sku and btrim(i.asin::text)=f.asin
  and i.condition::text=f.condition and i.deliverer_id=p.staff_id and i.status::text='商品登録前'
  and (i.sales_channel::text=p.account or (i.sales_channel::text='FBA' and p.account='FBA1'))
  returning i.id
 )
 update app.fba_inbound_items f set published_at=now(),released_at=now()
 from verified v where f.plan_id=p_plan and f.item_id=v.id;
 get diagnostics v_count=row_count;
 return v_count;
end $$;

revoke all on function app.create_fba_inbound_draft(uuid,uuid[]),app.cancel_fba_inbound_plan(uuid,integer),
 app.publish_fba_inbound_items(uuid,uuid[]) from public,anon,authenticated;
grant execute on function app.create_fba_inbound_draft(uuid,uuid[]),app.cancel_fba_inbound_plan(uuid,integer),
 app.publish_fba_inbound_items(uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
