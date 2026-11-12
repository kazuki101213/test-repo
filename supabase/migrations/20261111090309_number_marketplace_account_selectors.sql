-- Keep platform families for work queues, deadlines and historical imports.
alter table app.items add column sales_account_id text, add column purchase_account_id text;
alter table app.spare_accessories add column purchase_account_id text;

create function app.marketplace_account_label(account_id text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select case account_id when 'mercari-1' then 'メルカリ1' when 'mercari-2' then 'メルカリ2'
    when 'auctions-1' then 'ヤフオク1' when 'auctions-2' then 'ヤフオク2'
    when 'flea-1' then 'Yahoo!フリマ1' when 'flea-2' then 'Yahoo!フリマ2'
    when 'rakuma-1' then 'ラクマ1' end
$$;

create function app.marketplace_account_family(account_id text) returns text
language sql immutable strict set search_path=pg_catalog as $$
  select case
    when account_id in ('mercari-1','mercari-2') then 'メルカリ'
    when account_id in ('auctions-1','auctions-2') then 'ヤフオク'
    when account_id in ('flea-1','flea-2') then 'ヤフフリ'
    when account_id='rakuma-1' then 'ラクマ'
  end
$$;

alter table app.items add constraint items_sales_account_family_check check (
  sales_account_id is null or (sales_channel in ('メルカリ','ヤフオク')
    and (app.marketplace_account_family(sales_account_id)=sales_channel::text) is true));
alter table app.items add constraint items_purchase_account_family_check check (
  purchase_account_id is null or (app.marketplace_account_family(purchase_account_id)
    = case when marketplace='PayPayフリマ' then 'ヤフフリ' else marketplace::text end) is true);
alter table app.spare_accessories add constraint spares_purchase_account_family_check check (
  purchase_account_id is null or (app.marketplace_account_family(purchase_account_id)
    = case when marketplace='PayPayフリマ' then 'ヤフフリ' else marketplace end) is true);

-- An exact draft link wins. An unlinked record can inherit the account only from an unambiguous exact product ID.
create function app.imported_purchase_account(p_marketplace text,p_external_id text,p_draft_id uuid default null)
returns text language sql stable security definer set search_path=pg_catalog,app as $$
  select case
    when auth.uid() is not null and not exists (
      select 1 from app.staff where id=app.current_staff_id() and is_active
    ) then null
    else (
      select case when count(distinct d.account_label) filter (where d.id=p_draft_id)=1
        then min(d.account_label) filter (where d.id=p_draft_id)
        when count(distinct d.account_label)=1 then min(d.account_label) end
      from app.marketplace_purchase_drafts d
      where d.marketplace=case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end
        and d.marketplace_item_id=nullif(p_external_id,'')
    ) end
$$;
revoke all on function app.imported_purchase_account(text,text,uuid) from public,anon,authenticated;

create function app.keep_marketplace_account_consistent() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare purchase_label text; sale_account text; explicit_purchase boolean;
begin
  if tg_op='UPDATE' then
    if new.marketplace is distinct from old.marketplace and new.purchase_account_id is not distinct from old.purchase_account_id then
      new.purchase_account_id:=null;
    end if;
    if tg_table_name='items' then
      if new.sales_channel is distinct from old.sales_channel and new.sales_account_id is not distinct from old.sales_account_id then
        new.sales_account_id:=null;
      end if;
      if new.sales_account_id is not null and new.sales_account_id is distinct from old.sales_account_id then
        select l.account_id into sale_account from app.seller_listings l
        where l.item_id=new.id and l.channel=new.sales_channel and (l.active or (new.status='販売済' and l.verified_sale is not null))
        order by l.active desc,l.observed_at desc nulls last,l.id limit 1;
        if sale_account is not null and sale_account<>new.sales_account_id then
          raise exception 'この商品の出品は別のアカウントに紐づいています。出品記録を確認してください。' using errcode='22023';
        end if;
      end if;
    end if;
    explicit_purchase:=new.purchase_account_id is not null and
      (new.purchase_account_id is distinct from old.purchase_account_id or new.marketplace_item_id is distinct from old.marketplace_item_id);
  else
    explicit_purchase:=new.purchase_account_id is not null;
  end if;

  if explicit_purchase then
    if tg_table_name='items' then
      purchase_label:=app.imported_purchase_account(new.marketplace::text,new.marketplace_item_id,new.source_purchase_draft_id);
    else
      purchase_label:=app.imported_purchase_account(new.marketplace::text,new.marketplace_item_id);
    end if;
    if purchase_label is not null and purchase_label<>app.marketplace_account_label(new.purchase_account_id) then
      raise exception '仕入れリストの購入アカウントと一致しません。取引を確認してください。' using errcode='22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function app.keep_marketplace_account_consistent() from public,anon,authenticated;
create trigger zz_keep_item_marketplace_account before insert or update of marketplace,marketplace_item_id,purchase_account_id,sales_channel,sales_account_id
  on app.items for each row execute function app.keep_marketplace_account_consistent();
create trigger zz_keep_spare_marketplace_account before insert or update of marketplace,marketplace_item_id,purchase_account_id
  on app.spare_accessories for each row execute function app.keep_marketplace_account_consistent();

-- Relisting honors a saved choice, then the last verified account for the same platform.
create function app.listing_account_for(p_item app.items) returns text
language sql stable set search_path=pg_catalog,app as $$
  select coalesce((p_item).sales_account_id,(
    select l.account_id from app.seller_listings l
    where l.item_id=(p_item).id and l.channel=(p_item).sales_channel
      and app.marketplace_account_family(l.account_id)=(p_item).sales_channel::text
    order by l.active desc,l.observed_at desc nulls last,l.id limit 1
  ),app.default_marketplace_seller_account((p_item).sales_channel))
$$;
revoke all on function app.listing_account_for(app.items) from public,anon;
grant execute on function app.listing_account_for(app.items) to authenticated;

create or replace function app.inventory_marketplace_accounts(p_item_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,app as $$
  select jsonb_build_object(
    'purchase_account_label',coalesce(
      app.imported_purchase_account(i.marketplace::text,i.marketplace_item_id,i.source_purchase_draft_id),
      app.marketplace_account_label(i.purchase_account_id)),
    'sales_account_label',app.marketplace_account_label(coalesce(listing.account_id,history.account_id,
      case when parent.id is null then i.sales_account_id else parent.sales_account_id end,
      case when coalesce(parent.status,i.status) in ('受取前','検品中','商品登録前') and coalesce(parent.sold_on,i.sold_on) is null
        then case when parent.id is null then app.listing_account_for(i) else app.listing_account_for(parent) end end)),
    'flea_listing_account_label',app.marketplace_account_label(other_listing.account_id))
  from app.items i
  join app.staff viewer on viewer.id=app.current_staff_id() and viewer.is_active
  left join app.items parent on parent.id=i.parent_item_id and not parent.is_accessory
    and i.is_accessory and not app.is_standalone_accessory_serial(i.sku,i.lot_seq)
  left join lateral (
    select l.account_id from app.seller_listings l
    where l.item_id=coalesce(parent.id,i.id) and l.channel=coalesce(parent.sales_channel,i.sales_channel)
      and (l.active or (coalesce(parent.status,i.status)='販売済' and l.verified_sale is not null))
    order by l.active desc,l.observed_at desc nulls last,l.id limit 1
  ) listing on true
  left join app.seller_listings other_listing on other_listing.item_id=coalesce(parent.id,i.id)
    and other_listing.active and other_listing.observed_status in ('出品中','取引中')
    and other_listing.channel is distinct from coalesce(parent.sales_channel,i.sales_channel)
    and coalesce(parent.sold_on,i.sold_on) is null
  left join lateral (
    select o.account_id from app.seller_operations o
    where listing.account_id is null and coalesce(parent.status,i.status)='販売済'
      and o.item_id=coalesce(parent.id,i.id) and o.channel=coalesce(parent.sales_channel,i.sales_channel)
      and o.kind='listing' and o.status='succeeded' and nullif(o.result->>'external_id','') is not null
    order by o.created_at desc,o.id limit 1
  ) history on true
  where auth.uid() is not null and i.id=p_item_id and viewer.role in ('admin','purchaser','deliverer')
$$;

-- Apply numbered filters on the server before pagination. Generic options still match both accounts.
create function app.inventory_account_filter_matches(d jsonb, states jsonb) returns boolean
language plpgsql stable set search_path=pg_catalog,app as $$
declare field text; family text; values jsonb; labels jsonb;
begin
  foreach field in array array['marketplace','sales_channel'] loop
    values:=states->field;
    if jsonb_typeof(values) is distinct from 'array' then continue; end if;
    if jsonb_array_length(values)=0 then continue; end if;
    family:=coalesce(d->>field,'');
    if values ? family or (field='sales_channel' and
      ((family='FBA' and values ? 'FBA1') or (family='自己発送' and values ? '自己発送1'))) then continue; end if;
    if not (
      (family='メルカリ' and values ?| array['メルカリ1','メルカリ2']) or
      (family='ヤフオク' and values ?| array['ヤフオク1','ヤフオク2']) or
      (field='marketplace' and family in ('ヤフフリ','PayPayフリマ') and values ?| array['Yahoo!フリマ1','Yahoo!フリマ2'])
    ) then return false; end if;
    if labels is null then labels:=coalesce(app.inventory_marketplace_accounts((d->>'id')::uuid),'{}'::jsonb); end if;
    if not values ? coalesce(labels->>case when field='marketplace' then 'purchase_account_label' else 'sales_account_label' end,'') then
      return false;
    end if;
  end loop;
  return true;
end $$;
revoke all on function app.inventory_account_filter_matches(jsonb,jsonb) from public,anon;
grant execute on function app.inventory_account_filter_matches(jsonb,jsonb) to authenticated;

do $migration$
declare
  definition text;
  signature text;
  anchor text;
  replacement text;
begin
  for signature,anchor,replacement in
    select * from (values
      ('app.queue_seller_operation(uuid,text,jsonb,uuid)',
        'else app.default_marketplace_seller_account(i.sales_channel) end',
        'else app.listing_account_for(i) end'),
      ('app.seller_operation_context(uuid)',
        $$'photo_review_approved',app.listing_photos_approved(i.id)$$,
        $$'listing_account_id',app.listing_account_for(i),'photo_review_approved',app.listing_photos_approved(i.id)$$),
      ('app.read_inventory_page(text,jsonb,integer,jsonb)',
        'app.inventory_page_matches(d,$2,$1)',
        $$app.inventory_page_matches(d,$2 #- '{states,marketplace}' #- '{states,sales_channel}',$1)
    and app.inventory_account_filter_matches(d,$2->'states')$$),
      ('app.read_delivery_catalog_snapshot(text,jsonb,integer,jsonb)',
        'app.inventory_page_matches(d,$2,$1)',
        $$app.inventory_page_matches(d,$2 #- '{states,marketplace}' #- '{states,sales_channel}',$1)
    and app.inventory_account_filter_matches(d,$2->'states')$$),
      ('app.register_item_with_spare(jsonb,uuid)',
        'sales_channel,status,memo,source_purchase_draft_id)',
        'sales_channel,status,memo,source_purchase_draft_id,sales_account_id,purchase_account_id)'),
      ('app.register_item_with_spare(jsonb,uuid)',
        'v_input.memo,v_input.source_purchase_draft_id)',
        'v_input.memo,v_input.source_purchase_draft_id,v_input.sales_account_id,v_input.purchase_account_id)'),
      ('app.register_item_with_spare(jsonb,uuid)',
        'product_id,sales_channel,memo)',
        'product_id,sales_channel,memo,purchase_account_id)'),
      ('app.register_item_with_spare(jsonb,uuid)',
        'v_item.sales_channel,v_spare.usage_note)',
        'v_item.sales_channel,v_spare.usage_note,v_spare.purchase_account_id)'),
      ('app.move_inventory_accessory_to_spares(uuid,jsonb)',
        'cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note',
        'cost_amount,marketplace,marketplace_item_id,tracking_no,usage_note,purchase_account_id'),
      ('app.move_inventory_accessory_to_spares(uuid,jsonb)',
        $$p_spare_input->>'usage_note'
  ) returning$$,
        $$p_spare_input->>'usage_note',
    case when p_spare_input ? 'purchase_account_id' then p_spare_input->>'purchase_account_id'
      when v_item.marketplace::text=p_spare_input->>'marketplace' then v_item.purchase_account_id end
  ) returning$$),
      ('app.supplier_conversation(uuid)',
        $$select case when count(distinct account_label)=1 then min(account_label) else null end into account from app.marketplace_purchase_drafts d where d.marketplace=i.marketplace::text and d.marketplace_item_id=i.marketplace_item_id;$$,
        $$account:=coalesce(app.imported_purchase_account(i.marketplace::text,i.marketplace_item_id,i.source_purchase_draft_id),app.marketplace_account_label(i.purchase_account_id));$$),
      ('app.queue_supplier_operation(uuid,text,text,text,uuid)',
        ' select * into q from app.supplier_operations where id=p_request_id;',
        $$ if coalesce(app.imported_purchase_account(i.marketplace::text,i.marketplace_item_id,i.source_purchase_draft_id),app.marketplace_account_label(i.purchase_account_id))
    <> app.marketplace_account_label(p_account_id) then
   raise exception '記録されている購入アカウントを選択してください';
 end if;
 select * into q from app.supplier_operations where id=p_request_id;$$)
    ) edits(signature,anchor,replacement)
  loop
    definition:=replace(pg_get_functiondef(signature::regprocedure),chr(13),'');
    if strpos(definition,anchor)=0 then raise exception 'Marketplace account insertion point missing: %',signature; end if;
    execute replace(definition,anchor,replacement);
  end loop;
end $migration$;

-- Spares keep their imported account label even when they predate the manual selector.
create function app.spare_purchase_account_label(p_spare_id uuid) returns text
language sql stable security definer set search_path=pg_catalog,app as $$
  select coalesce(app.imported_purchase_account(s.marketplace,s.marketplace_item_id),app.marketplace_account_label(s.purchase_account_id))
  from app.spare_accessories s
  where s.id=p_spare_id and s.used_for_item_id is null and auth.uid() is not null
    and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
$$;
revoke all on function app.spare_purchase_account_label(uuid) from public,anon;
grant execute on function app.spare_purchase_account_label(uuid) to authenticated;

do $migration$
declare
  definition text:=pg_get_functiondef('app.read_resource_snapshot(text,jsonb,jsonb)'::regprocedure);
  anchor text:=$$to_jsonb(s)||jsonb_build_object('_owner_code',p.code) d from app.spare_accessories s$$;
begin
  if strpos(definition,anchor)=0 then raise exception 'Spare account insertion point missing'; end if;
  execute replace(definition,anchor,
    $$to_jsonb(s)||jsonb_build_object('_owner_code',p.code,'purchase_account_label',app.spare_purchase_account_label(s.id)) d from app.spare_accessories s$$);
end $migration$;
