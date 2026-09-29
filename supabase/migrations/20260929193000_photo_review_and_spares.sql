-- Uploaded photographs stay separate from the Amazon catalogue image.
-- A successful Drive export creates a review task; packing and shipping require approval.
alter table app.item_photos add column drive_file_id text;
create table app.photo_reviews (
  item_id uuid primary key references app.items(id) on delete cascade,
  drive_folder_id text not null,
  exported_photo_count integer not null check (exported_photo_count > 0),
  submitted_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references app.staff(id),
  updated_at timestamptz not null default now()
);
create index photo_reviews_pending_idx on app.photo_reviews(submitted_at) where approved_at is null;
alter table app.photo_reviews enable row level security;
grant select on app.photo_reviews to authenticated;
grant all on app.photo_reviews to service_role;
grant select on app.profiles, app.staff, app.items to service_role;
grant select, update on app.item_photos to service_role;
create policy photo_reviews_read on app.photo_reviews for select to authenticated using (
  app.is_admin() or exists (
    select 1 from app.items i where i.id = item_id and i.deliverer_id = app.current_staff_id()
  )
);

-- Enable the gate only after Google OAuth has been connected and the new UI is live.
create table app.photo_review_settings (
  id boolean primary key default true check (id),
  enforced boolean not null default false
);
insert into app.photo_review_settings(id,enforced) values(true,false);
alter table app.photo_review_settings enable row level security;
grant select on app.photo_review_settings to authenticated;
grant select, update on app.photo_review_settings to service_role;
create policy photo_review_settings_read on app.photo_review_settings for select to authenticated using (true);

create function app.photo_review_enforced() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enforced from app.photo_review_settings where id=true),false);
$$;
revoke all on function app.photo_review_enforced() from public,anon;
grant execute on function app.photo_review_enforced() to authenticated;

create function app.approve_photo_review(p_item_id uuid)
returns app.photo_reviews language plpgsql security definer set search_path = '' as $$
declare v_result app.photo_reviews; v_count integer;
begin
  if auth.uid() is null or not app.is_admin() then
    raise exception '写真確認の権限がありません' using errcode = '42501';
  end if;
  select count(*) into v_count from app.item_photos where item_id = p_item_id;
  update app.photo_reviews
     set approved_at = now(), approved_by = app.current_staff_id(), updated_at = now()
   where item_id = p_item_id and approved_at is null and exported_photo_count = v_count
   returning * into v_result;
  if not found then
    raise exception '未送信の写真があるか、確認済みです。Googleドライブに追加し直してください。' using errcode = '22023';
  end if;
  return v_result;
end $$;
revoke all on function app.approve_photo_review(uuid) from public, anon;
grant execute on function app.approve_photo_review(uuid) to authenticated;

create function app.invalidate_photo_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.photo_reviews set approved_at = null, approved_by = null, updated_at = now()
    where item_id = new.item_id;
  return new;
end $$;
create trigger item_photos_invalidate_review after insert on app.item_photos
  for each row execute function app.invalidate_photo_review();

create or replace function app.set_delivery_progress(p_item_id uuid,p_step text,p_done boolean,p_on date default null)
returns app.items language plpgsql security definer set search_path='' as $$
declare result app.items; today_jst date := (now() at time zone 'Asia/Tokyo')::date;
begin
 if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
 if p_done is null or p_step not in ('inspection_cleaning','listing','packed','shipped') then
  raise exception '作業項目を確認してください' using errcode='22023';
 end if;
 if p_done and p_step in ('packed','shipped') and p_on is null then
  raise exception '日付を入力してください' using errcode='22023';
 end if;
 perform app.assert_can_work_on(p_item_id);
 if p_done and p_step in ('packed','shipped') and app.photo_review_enforced() and not exists (
   select 1 from app.photo_reviews r where r.item_id = p_item_id and r.approved_at is not null
 ) then
   raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
 end if;
 update app.items set
  arrived_on=case when p_done then coalesce(arrived_on,today_jst) else arrived_on end,
  inspected_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(inspected_at,now()) else null end else inspected_at end,
  cleaned_at=case when p_step='inspection_cleaning' then case when p_done then coalesce(cleaned_at,now()) else null end else cleaned_at end,
  product_registered_at=case when p_step='listing' then case when p_done then coalesce(product_registered_at,now()) else null end else product_registered_at end,
  photo_uploaded_at=case when p_step='listing' then case when p_done then coalesce(photo_uploaded_at,now()) else null end else photo_uploaded_at end,
  packed_on=case when p_step='packed' then case when p_done then p_on else null end else packed_on end,
  shipped_on=case when p_step='shipped' then case when p_done then p_on else null end else shipped_on end
 where id=p_item_id returning * into result;
 return result;
end $$;

-- Legacy RPC is still callable: enforce the same check there.
create or replace function app.require_photo_review(p_item_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if app.photo_review_enforced() and not exists (select 1 from app.photo_reviews where item_id=p_item_id and approved_at is not null) then
    raise exception '管理アプリの写真確認が完了するまで、梱包・出荷はできません' using errcode='42501';
  end if;
end $$;
revoke all on function app.require_photo_review(uuid) from public, anon, authenticated;

create or replace function app.set_work_progress(p_item_id uuid, p_step text, p_done boolean default true)
returns app.items language plpgsql security definer set search_path = '' as $$
declare v_item app.items;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode='42501'; end if;
  if p_step not in ('arrived','registered','inspected','photo','packed','shipped') then
    raise exception '作業項目を確認してください' using errcode='22023';
  end if;
  perform app.assert_can_work_on(p_item_id);
  if p_done and p_step in ('packed','shipped') then perform app.require_photo_review(p_item_id); end if;
  update app.items set
    arrived_on = case when p_step='arrived' then case when p_done then current_date else null end else arrived_on end,
    product_registered_at = case when p_step='registered' then case when p_done then now() else null end else product_registered_at end,
    inspected_at = case when p_step='inspected' then case when p_done then now() else null end else inspected_at end,
    photo_uploaded_at = case when p_step='photo' then case when p_done then now() else null end else photo_uploaded_at end,
    packed_on = case when p_step='packed' then case when p_done then current_date else null end else packed_on end,
    shipped_on = case when p_step='shipped' then case when p_done then current_date else null end else shipped_on end
  where id=p_item_id returning * into v_item;
  return v_item;
end $$;

-- Reserve accessories are a separate ledger. They are not ordinary saleable stock.
create table app.spare_accessories (
  id uuid primary key default gen_random_uuid(),
  source_sheet_row integer unique,
  source_sku text,
  owner_staff_id uuid references app.staff(id),
  owner_name text,
  purchased_at date,
  title text not null,
  cost_amount bigint not null default 0 check (cost_amount >= 0),
  marketplace text,
  marketplace_item_id text,
  tracking_no text,
  usage_note text,
  linked_item_id uuid references app.items(id),
  used_for_item_id uuid references app.items(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index spare_accessories_owner_idx on app.spare_accessories(owner_staff_id);
alter table app.spare_accessories enable row level security;
grant select on app.spare_accessories to authenticated;
create policy spare_accessories_read on app.spare_accessories for select to authenticated using (
  app.is_admin() or owner_staff_id = app.current_staff_id()
);

create function app.allocate_spare_accessory(p_spare_id uuid, p_item_id uuid)
returns app.spare_accessories language plpgsql security definer set search_path = '' as $$
declare v_result app.spare_accessories;
begin
  if auth.uid() is null or app.current_role() not in ('admin','purchaser') then
    raise exception '予備を割り当てる権限がありません' using errcode='42501';
  end if;
  if not exists (select 1 from app.items where id=p_item_id) then
    raise exception '割り当て先の商品が見つかりません' using errcode='22023';
  end if;
  update app.spare_accessories set used_for_item_id=p_item_id, updated_at=now()
    where id=p_spare_id and used_for_item_id is null and usage_note is null
      and (app.is_admin() or owner_staff_id=app.current_staff_id())
    returning * into v_result;
  if not found then raise exception 'この予備は使用済みか、割り当てできません' using errcode='22023'; end if;
  return v_result;
end $$;
revoke all on function app.allocate_spare_accessory(uuid,uuid) from public, anon;
grant execute on function app.allocate_spare_accessory(uuid,uuid) to authenticated;


-- Snapshot of the reserve section of 仕入れ販売管理 (rows 3323-3344).
-- Sheet notes containing delivery addresses are deliberately excluded.
with source(source_sheet_row,source_sku,owner_name,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note) as (
 values
 (3323,'2b-AAEE-20260502-175','石川秀樹','2026-05-02','リモコン',1758,'ヤフオク','c1228042044','ヤマト646340135545',null),
 (3324,'3b-AAEE-20260502-145','石川秀樹','2026-05-02','リモコン',1457,'ヤフオク','q1228038391','ヤマト646340135545',null),
 (3325,'4b-AAEE-20260502-175','石川秀樹','2026-05-02','リモコン',1757,'ヤフオク','t1223962133','ヤマト646340135545',null),
 (3326,null,'株式会社吉光','2026-09-16','リモコン',0,'ヤフオク','1243959352','ヤマト623211133462','2344リモコン'),
 (3327,null,'久保田真由','2026-06-15','リモコン蓋',740,'その他','250-2416044-2821427','郵便628698508491',null),
 (3329,null,null,'2026-05-05','リモコン',2000,'メルカリ','m93183062306','郵便628790320642',null),
 (3330,null,'久保田真由','2026-07-08','リモコン',0,'ヤフオク','n1235408948','郵便628689522565','1933リモコン'),
 (3331,null,'石川秀樹','2026-05-05','リモコン',0,'ヤフフリ','z604043190','ヤマト623275478383','1528aリモコン'),
 (3332,null,'石川秀樹','2026-05-24','リモコン',3685,'ヤフオク','g1226658491','郵便628617746422','1576aリモコン'),
 (3333,null,'石川秀樹','2026-06-08','リモコン',8300,'ヤフオク','j1228041764','佐川444076880822','1738リモコン / 1755aリモコン'),
 (3334,null,'石川秀樹','2026-05-24','リモコン',10352,'ヤフオク','e1230589619','ヤマト3900-5055-3874','1630aリモコン'),
 (3335,null,'石川秀樹','2026-03-27','リモコン',2000,'メルカリ','m78850698210','郵便647304009321','1270aリモコン'),
 (3336,null,'石川秀樹','2026-05-18','リモコン',1680,'メルカリ','m68137917077','ヤマト626701515366','1580aリモコン'),
 (3337,null,'石川秀樹','2026-07-01','リモコン',0,'ヤフオク','j1234015690','ヤマト623190642115','1892aリモコン'),
 (3338,null,'石川秀樹','2026-05-30','リモコン',0,'メルカリ','m81833007306','郵便628651336972','1764aリモコン'),
 (3339,null,'石川秀樹','2026-05-23','リモコン',2000,'メルカリ','m37332601503','郵便628623312601','1649aリモコン'),
 (3340,null,'石川秀樹','2026-05-26','リモコン',1500,'メルカリ','m10177010792','ヤマト623109541283','1647リモコン / 1723リモコン / 1765aリモコン'),
 (3341,null,'石川秀樹','2026-07-09','リモコン',2000,'メルカリ','m74152529713','郵便647676016525','1942aリモコン'),
 (3342,null,'土井花菜','2026-09-18','リモコン',1830,'ヤフオク','b1244958717','郵便646846907803','2353リモコン / 2378リモコン'),
 (3343,null,null,'2026-09-08','リモコン',950,'メルカリ','m48999368969','',null),
 (3344,null,'土井花菜','2026-09-12','リモコン',998,'ヤフオク','f1234127932','定形外郵便','2316リモコン')
)
insert into app.spare_accessories(source_sheet_row,source_sku,owner_name,owner_staff_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note,linked_item_id)
select s.source_sheet_row,s.source_sku,s.owner_name,st.id,s.purchased_at::date,s.title,s.cost_amount,s.marketplace,s.marketplace_item_id,s.tracking_no,s.usage_note,i.id
from source s
left join app.staff st on st.name=s.owner_name and st.is_active
left join app.items i on i.sku=s.source_sku
on conflict (source_sheet_row) do nothing;

notify pgrst, 'reload schema';
