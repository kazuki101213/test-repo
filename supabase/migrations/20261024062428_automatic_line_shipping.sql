-- Settings are saved once per product. Missing media/settings hold the request;
-- they never select another product's picture or guess a shipping location.
create table app.delivery_line_preferences (
 item_id uuid primary key references app.items(id) on delete cascade,
 overview_photo_id uuid references app.item_photos(id) on delete set null,
 model_photo_id uuid references app.item_photos(id) on delete set null,
 shipping jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now()
);
create index delivery_line_preferences_overview on app.delivery_line_preferences(overview_photo_id);
create index delivery_line_preferences_model on app.delivery_line_preferences(model_photo_id);
alter table app.delivery_line_preferences enable row level security;
revoke all on app.delivery_line_preferences from public,anon,authenticated;
grant all on app.delivery_line_preferences to service_role;
grant select on app.delivery_line_preferences to authenticated;
create policy delivery_line_preferences_read on app.delivery_line_preferences for select to authenticated using (
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id()))
);
alter table app.delivery_line_outbox add column message_payload jsonb,add column last_error text;
alter table app.delivery_line_outbox add column code_cleaned_at timestamptz;
create index delivery_line_media_cleanup on app.delivery_line_outbox(next_attempt_at) where code_cleaned_at is null and state in ('sent','cancelled','failed');
insert into storage.buckets(id,name,public) values('line-shipping-codes','line-shipping-codes',false) on conflict(id) do nothing;

create function app.save_line_shipping_preferences(p_item_id uuid,p_overview uuid,p_model uuid,p_shipping jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare i app.items;photo uuid;source app.items;
begin
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 select * into i from app.items where id=p_item_id;
 if i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then raise exception '担当商品のみ設定できます' using errcode='42501';end if;
 if jsonb_typeof(p_shipping) is distinct from 'object' or octet_length(p_shipping::text)>1000
  or exists(select 1 from jsonb_object_keys(p_shipping) k where k not in ('shippingMethod','size','dropoff','weightKg','category')) then raise exception '配送設定を確認してください';end if;
 if p_shipping ? 'size' and coalesce(p_shipping->>'size','') not in ('','100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') then raise exception '配送サイズを確認してください';end if;
 if p_shipping ? 'dropoff' and coalesce(p_shipping->>'dropoff','') not in ('','セブンイレブン','ヤマト営業所','ローソン','郵便局') then raise exception '発送場所を確認してください';end if;
 foreach photo in array array[p_overview,p_model] loop
  if photo is null then continue;end if;
  select s.* into source from app.item_photos p join app.items s on s.id=p.item_id
   where p.id=photo and coalesce(p.photo_kind,'product')='product'
    and (p.storage_path not like '%/reflected-%' or p.item_id=i.id);
  if source.id is null or lower(app.product_serial(source.sku,source.lot_seq)) is distinct from lower(app.product_serial(i.sku,i.lot_seq)) then raise exception 'この商品の商品写真を選択してください';end if;
 end loop;
 insert into app.delivery_line_preferences(item_id,overview_photo_id,model_photo_id,shipping)
 values(i.id,p_overview,p_model,p_shipping) on conflict(item_id) do update
 set overview_photo_id=excluded.overview_photo_id,model_photo_id=excluded.model_photo_id,shipping=excluded.shipping,updated_at=now();
 perform app.kick_delivery_line();
end $$;

-- Same model-keyed catalog as packages/shared/src/productCategory.ts.
-- Large categories have a fixed size even before any shipping operation exists.
create function app.line_model_shipping_size(p_model text,p_title text) returns text
language sql immutable set search_path='' as $model$
 with catalog as (select key,value from jsonb_each_text('{"DMR-BRX2030":"100","DMR-BRX2050":"100","DMR-BRX2060":"100","DMR-BRZ1020":"100","DMR-BRG1030":"100","DMR-BRG2030":"100","DMR-BRG2050":"100","DMR-BRW550":"100","DMR-BRW1020":"100","DMR-BRW1050":"100","DMR-BRW1060":"100","DMR-BRW2060":"100","DMR-BRT530":"100","DMR-BRT1030":"100","DMR-BCW560":"100","DMR-BCW1060":"100","DMR-BCX2060":"100","DMR-SCZ2060":"100","DMR-UBX4030":"100","DMR-UBX4050":"100","DMR-UBX7050":"100","DMR-UBZ1020":"100","DMR-UBZ1030":"100","DMR-UBZ2020":"100","DMR-UBZ2030":"100","DMR-UCX4060":"100","DMR-UCX8060":"100","DMR-BRT1060":"100","DMR-BCT1060":"100","DMR-BCT2060":"100","DMR-UX4050":"100","DMR-UX7030":"100","DMR-UX7050":"100","DMR-BG2050":"100","DMR-BX2030":"100","DMR-BX2050":"100","DMR-BW1050":"100","DMR-4S100":"100","DMR-2W50":"100","DMR-2W51":"100","DMR-2W100":"100","DMR-2W101":"100","DMR-2W102":"100","DMR-2W103":"100","DMR-2W200":"100","DMR-2W201":"100","DMR-2W202":"100","DMR-2W203":"100","DMR-4W100":"100","DMR-4W101":"100","DMR-4W102":"100","DMR-4W200":"100","DMR-4W201":"100","DMR-4W202":"100","DMR-4W300":"100","DMR-2X200":"100","DMR-2X202":"100","DMR-2X203":"100","DMR-2X301":"100","DMR-2X302":"100","DMR-2X303":"100","DMR-2X602":"100","DMR-2X603":"100","DMR-4X403":"100","DMR-4X600":"100","DMR-4X602":"100","DMR-4X1002":"100","DMR-4X1003":"100","DMR-2T101":"100","DMR-4T103":"100","DMR-4T201":"100","DMR-4T202":"100","DMR-4T203":"100","DMR-4T302":"100","DMR-4T303":"100","DMR-4T402":"100","DMR-4T403":"100","DMR-4SE102":"100","DMR-4CS100":"100","DMR-2CW100":"100","DMR-2CW200":"100","DMR-4CW200":"100","DMR-4CW201":"100","DMR-2CX200":"100","DMR-2CT101":"100","DMR-4TS203":"100","DMR-4TS204":"100","DMR-4TS204S":"100","DMR-ZR1":"100","DP-UB45":"100","DP-UB45S":"100","TU-BUHD100":"100","BDZ-ZW550":"100","BDZ-ZW1500":"100","BDZ-ZW1700":"100","BDZ-ZW1800":"100","BDZ-ZW1900":"100","BDZ-ZW2500":"100","BDZ-ZW2700":"100","BDZ-ZW2800":"100","BDZ-ZT1500":"100","BDZ-ZT1700":"100","BDZ-ZT1800":"100","BDZ-ZT2000":"100","BDZ-ZT2500":"100","BDZ-ZT2800":"100","BDZ-ZT3500":"100","BDZ-FW500":"100","BDZ-FW1000":"100","BDZ-FW2000":"100","BDZ-FT1000":"100","BDZ-FT2000":"100","BDZ-FT3000":"100","BDZ-FBW1000":"100","BDZ-FBW1100":"100","BDZ-FBW2000":"100","BDZ-FBW2100":"100","BDZ-FBW2200":"100","BDZ-FBT1000":"100","BDZ-FBT2000":"100","BDZ-FBT2100":"100","BDZ-FBT2200":"100","BDZ-FBT3000":"100","BDZ-FBT4000":"100","BDZ-FBT4100":"100","BDZ-FBT4200":"100","BDZ-FBT6100":"100","BDP-S1700":"100","BDP-S6700":"100","UBP-X700":"100","BD-UT1200":"100","BD-UT2100":"100","BD-UT2200":"100","BD-NW1200":"100","BD-NW2100":"100","BD-NW2200":"100","BD-WW1200":"100","BD-NT1200":"100","BD-NT2200":"100","4B-C20AT3":"100","4B-C40AT3":"100","2B-C05BW1":"100","2B-C10BW1":"100","2B-C20BW1":"100","2B-C10BW2":"100","2B-C10BT1":"100","2B-C10BT3":"100","2B-C20BT3":"100","4B-C10BT3":"100","4B-C20BT3":"100","4B-C40BT3":"100","2B-C05CW1":"100","2B-C10CW1":"100","2B-C20CW1":"100","2B-C30CW1":"100","2B-C10CW2":"100","2B-C10CT1":"100","2B-C20CT1":"100","2B-C10CT4":"100","2B-C05DW1":"100","2B-C10DW1":"100","2B-C20DW1":"100","2B-C10DW2":"100","2B-C30DW1":"100","4B-C10DW3":"100","4B-C20DW3":"100","4B-C30DW3":"100","2B-C10DT1":"100","2B-C20DT1":"100","4B-C20DT3":"100","4B-C30DT3":"100","4B-C40DT3":"100","2B-C05EW1":"100","2B-C10EW1":"100","2B-C20EW1":"100","2B-C10EW2":"100","2B-C10ET1":"100","2B-C20ET1":"100","4B-C10EW3":"100","4B-C20EW3":"100","4B-C40EW3":"100","4B-C20ET3":"100","4B-C40ET3":"100","4B-C60ET3":"100","2B-C10GW1":"100","2B-C20GW1":"100","2B-C20GT1":"100","4B-C20GT3":"100","4B-C40GT3":"100","DBR-UT109":"100","DBR-UT209":"100","DBR-M2008":"100","DBR-M3009":"100","DBR-M3010":"100","DBR-M4008":"100","DBR-M4010":"100","DBR-4KZ200":"100","DBR-4KZ400":"100","DBR-4KZ600":"100","DBR-W508":"100","DBR-W509":"100","DBR-W1007":"100","DBR-W1008":"100","DBR-W1009":"100","DBR-W1010":"100","DBR-T1007":"100","DBR-T1008":"100","DBR-T1009":"100","DBR-T1010":"100","DBR-W2007":"100","DBR-W2008":"100","DBR-W2009":"100","DBR-W2010":"100","DBR-T2008":"100","DBR-T2010":"100","DBR-T3007":"100","DBR-T3008":"100","TT-4K100":"100","VZ239HR":"140","VG249Q1A":"140","PA248QV":"140","PA247CV":"140","PA278QV":"140","PA278CV":"140","EW3270U":"140","GW2283":"140","BENQ GL2780":"140","EW2880U":"140","PD3205U":"140","PD2705U":"140","SW272U":"140","XL2546":"140","EL2870U":"140","GW2780":"140","EW3280U":"140","PD2705Q":"140","XL2546K":"140","XL2411K":"140","EX2510S":"140","EX2710S":"140","XL2746K":"140","EX3210R":"140","EX2710U":"140","EX240N":"140","EX270QM":"140","XL2566K":"140","XL2546X":"140","P2418HT":"140","U2720QM":"140","AW2521HF":"140","S2721HS":"140","S2721DS":"140","S3221QS":"140","S2721QS":"140","S2721DGF":"140","C2422HE":"140","U2422H":"140","U2722DE":"140","U2422HE":"140","S2522HG":"140","S2722DC":"140","S2722QC":"140","C1422H":"140","U3223QE":"140","U2723QX":"140","G3223Q":"140","AW2523HF":"140","G2524H":"140","24UD58":"140","29UM69G":"140","UBK90":"140","27UL850":"140","27UL500":"140","32ML600M":"140","27GL850":"140","27GL650F":"140","29WL500":"140","27MD5KL":"140","27EA430V":"140","24MD4KL":"140","27ML600S":"140","24ML600S":"140","29WN600":"140","27GN950":"140","32UN650":"140","32UN500":"140","27GN600":"140","27UP850":"140","24QP750":"140","27QN880":"140","29WP500":"140","27QN600":"140","32GN600":"140","16MQ70":"140","32UP550N":"140","28MQ750":"140","27GR75Q":"140","32SR50F":"140","27SR50F":"140","32SR83U":"140","32SR73U":"140"}'::jsonb)),
 normalized as (select btrim(regexp_replace(translate(upper(normalize(coalesce(p_model,''),NFKC)),'‐‑‒–—−ー','-------'),'\s+',' ','g')) model,
 btrim(regexp_replace(translate(upper(normalize(coalesce(p_title,''),NFKC)),'‐‑‒–—−ー','-------'),'\s+',' ','g')) title)
 select case when n.model<>'' then (select value from catalog where key=n.model)
 else (select c.value from catalog c where strpos(n.title,c.key)>0
  and substring(n.title from greatest(1,strpos(n.title,c.key)-1) for case when strpos(n.title,c.key)=1 then 0 else 1 end) !~ '[A-Z0-9]'
  and substring(n.title from strpos(n.title,c.key)+length(c.key) for 1) !~ '[A-Z0-9]'
  order by length(c.key) desc limit 1) end from normalized n;
$model$;
create function app.line_fixed_shipping_size(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select case when not i.is_accessory then app.line_model_shipping_size(p.model_no,i.title) end
 from app.items i left join app.products p on p.id=i.product_id where i.id=p_item_id;
$$;
revoke all on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) from public,anon;
grant execute on function app.line_model_shipping_size(text,text),app.line_fixed_shipping_size(uuid) to authenticated,service_role;

-- Small goods learn from a completed shipment of the same ASIN or maker/model.
-- Only size is shared: no customer, recipient, LINE ID or supplier data.
create table app.delivery_line_size_history (
 product_key text primary key,size text not null check(size in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット')),
 shipped_on date not null,updated_at timestamptz not null default now()
);
alter table app.delivery_line_size_history enable row level security;
revoke all on app.delivery_line_size_history from public,anon,authenticated;
grant select on app.delivery_line_size_history to authenticated;
grant all on app.delivery_line_size_history to service_role;
create policy delivery_line_size_history_read on app.delivery_line_size_history for select to authenticated using(
 exists(select 1 from app.staff s where s.id=app.current_staff_id() and s.is_active)
);
create function app.line_small_product_key(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select case when upper(coalesce(nullif(i.asin,''),p.asin,'')) ~ '^[A-Z0-9]{10}$'
 then 'asin:'||upper(coalesce(nullif(i.asin,''),p.asin))
 when nullif(btrim(p.model_no),'') is not null and nullif(btrim(p.maker),'') is not null
 then 'model:'||jsonb_build_array(upper(normalize(btrim(p.maker),NFKC)),upper(normalize(btrim(p.model_no),NFKC)))::text end
 from app.items i left join app.products p on p.id=i.product_id where i.id=p_item_id and app.line_fixed_shipping_size(i.id) is null;
$$;
create function app.line_learned_shipping_size(p_item_id uuid) returns text
language sql stable set search_path='' as $$
 select h.size from app.delivery_line_size_history h where h.product_key=app.line_small_product_key(p_item_id);
$$;
create function app.remember_line_shipping_size(p_item_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare i app.items;product text;actual_size text;
begin
 select * into i from app.items where id=p_item_id;
 if i.shipped_on is null or i.seller_cancelled_at is not null then return;end if;
 product:=app.line_small_product_key(i.id);if product is null then return;end if;
 select o.payload->>'size' into actual_size from app.seller_operations o
 where o.item_id=i.id and o.status='succeeded' and o.kind in ('shipping_code','register_package')
 and o.payload->>'trade_key'=i.seller_trade_key order by o.created_at desc limit 1;
 actual_size:=coalesce(nullif(actual_size,''),(select nullif(shipping->>'size','') from app.delivery_line_preferences where item_id=i.id));
 if actual_size not in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケットポストmini','ゆうパケット') or actual_size is null then return;end if;
 insert into app.delivery_line_size_history(product_key,size,shipped_on) values(product,actual_size,i.shipped_on)
 on conflict(product_key) do update set size=excluded.size,shipped_on=excluded.shipped_on,updated_at=now()
 where excluded.shipped_on>=app.delivery_line_size_history.shipped_on;
end $$;
create function app.capture_line_shipping_size() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.shipped_on is not null and new.shipped_on is distinct from old.shipped_on then perform app.remember_line_shipping_size(new.id);end if;
 return new;
end $$;
create trigger line_learn_shipping_size after update of shipped_on on app.items for each row execute function app.capture_line_shipping_size();
-- Learn existing verified shipments without issuing codes or sending old requests.
do $$declare shipped_item record;begin
 for shipped_item in select distinct item_id from app.seller_operations o join app.items i on i.id=o.item_id
 where o.kind in ('shipping_code','register_package') and o.status='succeeded' and i.shipped_on is not null
 and nullif(o.payload->>'size','') is not null order by item_id loop perform app.remember_line_shipping_size(shipped_item.item_id);end loop;
end $$;
revoke all on function app.line_small_product_key(uuid),app.line_learned_shipping_size(uuid) from public,anon;
grant execute on function app.line_small_product_key(uuid),app.line_learned_shipping_size(uuid) to authenticated,service_role;
revoke all on function app.remember_line_shipping_size(uuid),app.capture_line_shipping_size() from public,anon,authenticated;
grant execute on function app.remember_line_shipping_size(uuid) to service_role;

-- The existing shipping panel shows the same saved per-product defaults used
-- by automatic acquisition. Read access above is restricted to its assignee.
do $patch$ declare original text;patched text;begin
 original:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 patched:=replace(original,'''category'',s.p->''category''))','''category'',s.p->''category'')) || coalesce((select shipping from app.delivery_line_preferences where item_id=i.id),''{}''::jsonb) || case when app.line_fixed_shipping_size(i.id) is not null then jsonb_build_object(''size'',app.line_fixed_shipping_size(i.id)) when nullif(coalesce((select shipping->>''size'' from app.delivery_line_preferences where item_id=i.id),s.p->>''size''),'''') is null and app.line_learned_shipping_size(i.id) is not null then jsonb_build_object(''size'',app.line_learned_shipping_size(i.id)) else ''{}''::jsonb end');
 if patched=original then raise exception 'Shipping defaults anchor missing';end if;
 execute patched;
end $patch$;
grant execute on function app.seller_operation_context(uuid) to service_role;

create function app.line_shipping_eligible(p_id uuid) returns boolean
language sql stable set search_path='' as $$
 select coalesce((select not l.blocked and s.is_active and s.id=i.deliverer_id
  and l.linked_at<=o.created_at and t.resolved_at is null and i.status='取引中' and i.shipped_on is null
  and i.sold_on is null and i.seller_cancelled_at is null
  and i.sales_channel in ('メルカリ','ヤフオク') and o.trade_key=i.seller_trade_key
  and exists(select 1 from app.seller_listings sl where sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key and sl.channel=i.sales_channel)
  and not exists(select 1 from app.delivery_notice_completions c where c.staff_id=s.id and c.item_id=i.id and c.notice_id='shipping:'||t.id::text)
 from app.delivery_line_outbox o join app.delivery_line_links l on l.id=o.link_id join app.staff s on s.id=l.staff_id
 join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id where o.id=p_id),false);
$$;
create function app.line_shipping_media(p_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('itemId',i.id,'serial',app.product_serial(i.sku,i.lot_seq),'sku',i.sku,
  'supplierUrl',i.marketplace_url,'photoPaths',jsonb_build_array(front.storage_path,model.storage_path),'codeOperationId',code.id,
  'withoutBarcode',case when code.id is null then 'size_unset' end)
 from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id join app.items i on i.id=t.item_id
 join app.delivery_line_preferences pref on pref.item_id=i.id
 join app.item_photos front on front.id=pref.overview_photo_id and coalesce(front.photo_kind,'product')='product'
 join app.item_photos model on model.id=pref.model_photo_id and coalesce(model.photo_kind,'product')='product'
 left join lateral(select op.id from app.seller_operations op join app.seller_listings sl on sl.item_id=i.id and sl.active and sl.trade_key=o.trade_key
  where op.item_id=i.id and op.account_id=sl.account_id and op.channel=sl.channel and op.kind in ('shipping_code','register_package')
   and op.status='succeeded' and op.payload->>'trade_key'=o.trade_key and op.created_at>=t.created_at-interval '5 minutes'
   and nullif(op.result->>'qr_code','') is not null order by op.created_at desc limit 1) code on true
 where o.id=p_id and app.line_shipping_eligible(o.id)
  and (code.id is not null or nullif(coalesce(app.line_fixed_shipping_size(i.id),pref.shipping->>'size',app.seller_operation_context(i.id)->'shipping_defaults'->>'size'),'') is null);
$$;

create function app.line_shipping_context(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare i app.items;p app.delivery_line_preferences;q app.delivery_line_outbox;reason text;
begin
 select * into i from app.items where id=p_item_id;
 if auth.uid() is null or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 or i.id is null or not (app.is_admin() or i.deliverer_id=app.current_staff_id()) then raise exception '担当商品のみ確認できます' using errcode='42501';end if;
 select * into p from app.delivery_line_preferences where item_id=i.id;
 select o.* into q from app.delivery_line_outbox o join app.delivery_shipping_tasks t on t.id=o.task_id
 where t.item_id=i.id order by o.created_at desc limit 1;
 reason:=case when p.model_photo_id is null or p.overview_photo_id is null then '通知写真を指定してください'
  when q.id is null then '次の新しい発送依頼から自動通知します'
  when q.state='sent' then 'LINEへ送信済み'
  when q.state='cancelled' then 'この発送依頼は終了しました'
  when q.last_error is not null then q.last_error
  when app.line_shipping_media(q.id) is null then '配送設定・発送コードの確認待ちです'
  else 'LINE通知の準備中です' end;
 return jsonb_build_object('overviewPhotoId',p.overview_photo_id,'modelPhotoId',p.model_photo_id,'shipping',coalesce(p.shipping,'{}'),
  'state',q.state,'message',reason,'enabled',coalesce((select enabled from app.delivery_line_settings where singleton),false));
end $$;

-- One request after the patrol, and one for each actual operation completion.
-- No permanent minute poll. Completed/uncertain code operations are never issued twice.
create function app.extension_prepare_line_shipping(p_account_ids text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o record;i app.items;settings jsonb;operation uuid;n integer:=0;reason text;
begin
 if auth.uid() is null or not app.is_admin() or not exists(select 1 from app.staff where id=app.current_staff_id() and is_active) then raise exception '権限がありません' using errcode='42501';end if;
 if cardinality(p_account_ids) not between 1 and 4 or exists(select 1 from unnest(p_account_ids) a where a not in ('mercari-1','mercari-2','auctions-1','auctions-2') or a is null) then raise exception 'アカウントを確認してください';end if;
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return jsonb_build_object('queued',0);end if;
 for o in select q.id,q.trade_key,t.item_id,l.account_id,l.trade_key current_trade from app.delivery_line_outbox q
 join app.delivery_shipping_tasks t on t.id=q.task_id join app.items item on item.id=t.item_id
 join app.seller_listings l on l.item_id=item.id and l.active and l.account_id=any(p_account_ids)
 where q.state='pending' and q.attempts=0
 and exists(select 1 from app.delivery_line_preferences pref where pref.item_id=item.id and pref.overview_photo_id is not null and pref.model_photo_id is not null)
 order by q.created_at limit 20 for update of q skip locked loop
  if o.trade_key is null then update app.delivery_line_outbox set trade_key=o.current_trade where id=o.id;end if;
  if not app.line_shipping_eligible(o.id) then update app.delivery_line_outbox set state='cancelled' where id=o.id;continue;end if;
  if app.line_shipping_media(o.id) is not null then continue;end if;
  select * into i from app.items where id=o.item_id;
  reason:=null;
  if not exists(select 1 from app.delivery_line_preferences where item_id=i.id and overview_photo_id is not null and model_photo_id is not null) then reason:='通知写真を指定してください';end if;
  settings:=coalesce(app.seller_operation_context(i.id)->'shipping_defaults','{}')||coalesce((select shipping from app.delivery_line_preferences where item_id=i.id),'{}');
  if nullif(settings->>'size','') is null and app.line_learned_shipping_size(i.id) is not null then settings:=settings||jsonb_build_object('size',app.line_learned_shipping_size(i.id));end if;
  if app.line_fixed_shipping_size(i.id) is not null then settings:=settings||jsonb_build_object('size',app.line_fixed_shipping_size(i.id));end if;
  if coalesce(settings->>'size','') not in ('100','140','宅急便コンパクト','ゆうパケットプラス','ゆうパケット')
   or coalesce(settings->>'shippingMethod','') not in ('らくらくメルカリ便','ゆうゆうメルカリ便','おてがる配送（ヤマト運輸）','おてがる配送（日本郵便）')
   or (settings->>'shippingMethod' in ('らくらくメルカリ便','おてがる配送（ヤマト運輸）') and coalesce(settings->>'dropoff','') not in ('セブンイレブン','ヤマト営業所'))
   or (settings->>'shippingMethod' in ('ゆうゆうメルカリ便','おてがる配送（日本郵便）') and coalesce(settings->>'dropoff','') not in ('ローソン','郵便局')) then reason:=coalesce(reason,'配送サイズ・発送場所を保存してください');end if;
  if reason is not null then update app.delivery_line_outbox set last_error=reason where id=o.id;continue;end if;
  if exists(select 1 from app.seller_operations where item_id=i.id and status in ('queued','running','uncertain')) then continue;end if;
  if exists(select 1 from app.seller_operations where item_id=i.id and kind='shipping_code' and payload->>'trade_key'=o.current_trade and payload ? 'automatic_line') then
   update app.delivery_line_outbox set last_error='発送コードを自動取得できませんでした。発送画面で確認してください' where id=o.id;continue;
  end if;
  begin
   operation:=app.queue_seller_operation(i.id,'shipping_code',settings||jsonb_build_object('trade_key',o.current_trade,'expected_revision',i.updated_at,'automatic_line',o.id),gen_random_uuid());
   n:=n+1;update app.delivery_line_outbox set last_error=null where id=o.id;
  exception when others then update app.delivery_line_outbox set last_error='発送コードの取得待ちです。発送画面で確認してください' where id=o.id;
  end;
 end loop;
 perform app.kick_delivery_line();
 return jsonb_build_object('queued',n);
end $$;

create function app.arm_delivery_line_retry() returns void
language plpgsql security definer set search_path='' as $$
declare retry_at timestamptz;
begin
 select min(next_attempt_at) into retry_at from app.delivery_line_outbox
 where (state='pending' and attempts between 1 and 4 or state='sending' and attempts between 1 and 5);
 if retry_at is null then
  perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-retry';return;
 end if;
 retry_at:=greatest(date_trunc('minute',now())+interval '1 minute',date_trunc('minute',retry_at)+interval '1 minute');
 perform cron.schedule('delivery-line-retry',to_char(retry_at at time zone 'UTC','MI HH24 DD MM')||' *','select app.retry_delivery_line();');
end $$;
create or replace function app.claim_delivery_line() returns table(id uuid,lease uuid,recipient text,payload jsonb,eligible boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) then return;end if;
 update app.delivery_line_outbox o set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where o.state in ('pending','sending') and o.next_attempt_at<=now() and (o.attempts>=5 or o.first_attempt_at<now()-interval '23 hours');
 return query with ready as (
 select o.id from app.delivery_line_outbox o where o.state in ('pending','sending') and o.next_attempt_at<=now() and o.attempts<5
  and coalesce(o.first_attempt_at,now())>now()-interval '23 hours' and app.line_shipping_media(o.id) is not null order by o.next_attempt_at limit 2 for update skip locked
 ),claimed as (
 update app.delivery_line_outbox o set state='sending',attempts=o.attempts+1,first_attempt_at=coalesce(o.first_attempt_at,now()),
 next_attempt_at=now()+interval '5 minutes',lease=gen_random_uuid() from ready r where o.id=r.id returning o.*
 ) select o.id,o.lease,l.line_user_id,coalesce(o.message_payload,jsonb_build_object('media',app.line_shipping_media(o.id))),app.line_shipping_eligible(o.id)
 from claimed o join app.delivery_line_links l on l.id=o.link_id;
 perform app.arm_delivery_line_retry();
end $$;
create function app.prepare_delivery_line_message(p_id uuid,p_lease uuid,p_messages jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not app.line_shipping_eligible(p_id) or jsonb_typeof(p_messages) is distinct from 'object' or octet_length(p_messages::text)>20000 then return false;end if;
 update app.delivery_line_outbox set message_payload=coalesce(message_payload,p_messages) where id=p_id and lease=p_lease and state='sending';
 return found;
end $$;

create or replace function app.kick_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
declare dispatch_token text;project_url text;request_id bigint;
begin
 if not coalesce((select enabled from app.delivery_line_settings where singleton),false) or not exists(
  select 1 from app.delivery_line_outbox o where state in ('pending','sending') and next_attempt_at<=now()
   and attempts<5 and app.line_shipping_media(o.id) is not null
 ) then return null;end if;
 select decrypted_secret into dispatch_token from vault.decrypted_secrets where name='delivery_push_dispatch_token';
 select decrypted_secret into project_url from vault.decrypted_secrets where name='delivery_push_project_url';
 if dispatch_token is null or project_url is null then return null;end if;
 select net.http_post(url:=project_url||'/functions/v1/delivery-line',headers:=jsonb_build_object('Content-Type','application/json','x-delivery-dispatch',dispatch_token),
 body:='{"action":"dispatch"}'::jsonb,timeout_milliseconds:=50000) into request_id;return request_id;
end $$;
create function app.retry_delivery_line() returns bigint
language plpgsql security definer set search_path='' as $$
begin
 perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-retry';
 update app.delivery_line_outbox set state='failed',last_error='LINE通知を完了できませんでした。管理者へ確認してください'
 where state in ('pending','sending') and next_attempt_at<=now() and (attempts>=5 or first_attempt_at<now()-interval '23 hours');
 update app.delivery_line_outbox o set state='cancelled' where state in ('pending','sending') and attempts>0
  and (not app.line_shipping_eligible(o.id) or app.line_shipping_media(o.id) is null);
 perform app.arm_delivery_line_retry();
 return app.kick_delivery_line();
end $$;
create or replace function app.finish_delivery_line(p_id uuid,p_lease uuid,p_state text,p_status integer) returns void
language plpgsql security definer set search_path='' as $$
begin
 update app.delivery_line_outbox set state=case when p_state='pending' and attempts>=5 then 'failed' else p_state end,
 last_status=p_status,sent_at=case when p_state='sent' then now() else sent_at end,next_attempt_at=now()+interval '5 minutes',
 last_error=case when p_state='failed' or p_state='pending' and attempts>=5 then 'LINEへの通知に失敗しました。管理者へ確認してください' else last_error end
 where id=p_id and lease=p_lease and state='sending' and p_state in ('pending','sent','cancelled','failed');
 if found then perform app.arm_delivery_line_retry();end if;
end $$;
create function app.capture_line_code_completion() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind in ('shipping_code','register_package') and new.status='succeeded' and old.status is distinct from new.status then perform app.kick_delivery_line();end if;
 return new;
end $$;
create trigger seller_operation_line_code after update of status on app.seller_operations for each row execute function app.capture_line_code_completion();
do $$begin perform cron.unschedule(jobid) from cron.job where jobname='delivery-line-shipping';end $$;

revoke all on function app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb),app.line_shipping_context(uuid) from public,anon;
grant execute on function app.save_line_shipping_preferences(uuid,uuid,uuid,jsonb),app.line_shipping_context(uuid) to authenticated;
revoke all on function app.extension_prepare_line_shipping(text[]) from public,anon;
grant execute on function app.extension_prepare_line_shipping(text[]) to authenticated;
revoke all on function app.line_shipping_eligible(uuid),app.line_shipping_media(uuid),app.prepare_delivery_line_message(uuid,uuid,jsonb),app.retry_delivery_line(),app.arm_delivery_line_retry(),app.capture_line_code_completion() from public,anon,authenticated;
grant execute on function app.line_shipping_eligible(uuid),app.line_shipping_media(uuid),app.prepare_delivery_line_message(uuid,uuid,jsonb),app.retry_delivery_line() to service_role;
notify pgrst,'reload schema';
