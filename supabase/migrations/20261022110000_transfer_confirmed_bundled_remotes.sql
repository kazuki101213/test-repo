-- Transfer registered remotes, or a bundled remote explicitly documented on the body.
-- A template alone must not invent an accessory that was never reported.
create or replace function app.apply_malfunction_reply() returns trigger
language plpgsql security definer set search_path=pg_catalog,app as $$
declare previous_channel app.sales_channel; existing_spare boolean;
begin
 if auth.uid() is null or new.author_id is distinct from app.current_staff_id() then return new;end if;
 if not exists(select 1 from app.items i join app.staff s on s.id=new.author_id where i.id=new.item_id and i.status='動作不良' and i.sold_on is null and (s.role='admin' or (s.role='purchaser' and i.purchaser_id=s.id))) then return new;end if;
 select sales_channel into previous_channel from app.items where id=new.item_id for update;
 if new.task_kind='仕入先確認' then
  update app.items set supplier_contact_requested_at=coalesce(supplier_contact_requested_at,new.created_at) where id=new.item_id;
 elsif new.task_kind like '%ヤフオク%' then
  if new.task_kind in ('Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
                       'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク')
   and exists(select 1 from app.items body where body.id=new.item_id and not body.is_accessory and (
     exists(select 1 from app.items remote
      where app.product_serial(remote.sku,remote.lot_seq)=app.product_serial(body.sku,body.lot_seq)
       and remote.is_accessory and remote.title ilike '%リモコン%')
     or (concat_ws(' ',body.accessories,body.malfunction_comment) ilike '%リモコン%'
      and concat_ws(' ',body.accessories,body.malfunction_comment) !~ 'リモコン[がはの 、　]*(なし|無し|ない|無い|欠品|未付属)')
   )) then
   select exists(select 1 from app.spare_accessories s join app.items body on body.id=new.item_id
    where lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq)) and s.title ilike '%リモコン%') into existing_spare;
   -- Transfer before the body update can synchronize the accessory SKU.
   perform app.prepare_yahoo_auction_item(new.item_id);
   -- Preserve the explicit fault report on a newly registered, bundled (zero extra cost) remote.
   if not existing_spare and exists(select 1 from app.items where id=new.item_id
    and malfunction_comment ~ 'リモコン[^。\n]{0,30}(作動しない|動かない|不動|反応しない)') then
    update app.spare_accessories s set title='リモコン（作動しないとの報告あり）'
    from app.items body where body.id=new.item_id and lower(btrim(s.usage_note))=lower(app.product_serial(body.sku,body.lot_seq))
     and s.source_sku is null and s.cost_amount=0 and s.used_for_item_id is null;
   end if;
  end if;
  update app.items set
   workflow_previous_sales_channel=previous_channel,workflow_decision='yahoo',sales_channel='ヤフオク',
   condition=case when new.task_kind in ('Panasonic×ヤフオク','SONY×ヤフオク','SHARP×ヤフオク','TOSHIBA×ヤフオク') then '可'::app.item_condition else condition end,
   malfunction_resolved_at=clock_timestamp(),malfunction_resolved_by=new.author_id,status='商品登録前'
  where id=new.item_id;
 end if;
 return new;
end $$;
revoke all on function app.apply_malfunction_reply() from public,anon,authenticated;
