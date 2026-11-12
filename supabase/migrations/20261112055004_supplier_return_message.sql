alter table app.supplier_operations add column return_tracking_no text;

-- Queue the same supplier operation as a manually sent message, using the purchase record.
create function app.queue_supplier_return_message(p_item app.items, p_tracking_no text, p_request_id uuid)
returns void language plpgsql set search_path=pg_catalog,app as $$
declare
  account_label text;
  destination_account text;
  message_body text:='商品を返送しました。'||chr(10)||'追跡番号：'||p_tracking_no||chr(10)||'よろしくお願いいたします。';
begin
  if p_item.marketplace not in ('ヤフオク','メルカリ') then return; end if;
  account_label:=coalesce(app.imported_purchase_account(p_item.marketplace::text,
    p_item.marketplace_item_id,p_item.source_purchase_draft_id),app.marketplace_account_label(p_item.purchase_account_id));
  destination_account:=case account_label when 'ヤフオク1' then 'auctions-1' when 'ヤフオク2' then 'auctions-2'
    when 'メルカリ1' then 'mercari-1' when 'メルカリ2' then 'mercari-2' end;
  if nullif(btrim(p_item.marketplace_item_id),'') is null
    or app.marketplace_account_family(destination_account) is distinct from p_item.marketplace::text then
    raise exception '仕入れ時の購入アカウントと商品IDを確認してください。追跡番号の送信先を特定できません。'
      using errcode='22023';
  end if;

  -- A message already confirmed on the site survives an app-only cancellation.
  if exists(select 1 from app.supplier_operations q where q.item_id=p_item.id and q.status='succeeded'
    and q.return_tracking_no=p_tracking_no and q.account_id=destination_account
    and q.marketplace=p_item.marketplace::text and q.external_id=p_item.marketplace_item_id) then return; end if;

  update app.supplier_operations q set status='failed',finished_at=clock_timestamp(),
    note='返品の追跡番号の送信を優先したため、取得を取り消しました'
  where q.item_id=p_item.id and q.kind='read' and q.status='queued';

  perform app.queue_supplier_operation(p_item.id,'send',message_body,destination_account,p_request_id);
  update app.supplier_operations set return_tracking_no=p_tracking_no where id=p_request_id;
end $$;
revoke all on function app.queue_supplier_return_message(app.items,text,uuid) from public,anon,authenticated;

-- Both listing and claiming enforce the current transaction. Only the return notice may run after completion.
create function app.supplier_operation_is_current(q app.supplier_operations, i app.items)
returns boolean language sql stable set search_path=pg_catalog,app as $$
  select i.sold_on is null and i.marketplace_item_id=q.external_id and i.marketplace::text=q.marketplace
    and i.supplier_contact_requested_at=q.contact_requested_at
    and case when q.return_tracking_no is null then i.status='動作不良'
      else i.status='返品処理' and i.return_tracking_no=q.return_tracking_no end
$$;
revoke all on function app.supplier_operation_is_current(app.supplier_operations,app.items) from public,anon,authenticated;

create or replace function app.extension_supplier_queue(p_account_ids text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app as $$
begin
  if auth.uid() is null or not app.is_admin() or not exists(
    select 1 from app.staff where id=app.current_staff_id() and is_active
  ) then raise exception '権限がありません' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q)) from (
    select o.* from app.supplier_operations o join app.items i on i.id=o.item_id
    where o.status='queued' and o.account_id=any(p_account_ids) and app.supplier_operation_is_current(o,i)
    order by o.created_at limit 10
  ) q),'[]'::jsonb);
end $$;

create or replace function app.extension_claim_supplier_operation(p_id uuid,p_account_id text)
returns boolean language plpgsql security definer set search_path=pg_catalog,app as $$
declare
  item app.items;
begin
  if auth.uid() is null or not app.is_admin() or not exists(
    select 1 from app.staff where id=app.current_staff_id() and is_active
  ) then raise exception '権限がありません' using errcode='42501'; end if;
  -- Lock the item before the operation, in the same order as a return or cancellation.
  select i.* into item from app.items i join app.supplier_operations q on q.item_id=i.id
  where q.id=p_id and q.account_id=p_account_id and q.status='queued' for update of i;
  if not found then return false; end if;

  update app.supplier_operations q set status='running',claimed_at=clock_timestamp()
  where q.id=p_id and q.account_id=p_account_id and q.status='queued'
    and app.supplier_operation_is_current(q,item);
  if found then return true; end if;
  update app.supplier_operations set status='failed',finished_at=clock_timestamp(),
    note='商品の状態が変更されたため実行しませんでした'
  where id=p_id and account_id=p_account_id and status='queued';
  return false;
end $$;

do $patch$
declare
  definition text:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
  completion text:='target:=''返品処理'';'||chr(10)||'  update app.items set returned_on=';
  cancellation text:='target:=''動作不良'';update app.items set returned_on=null,return_tracking_no=null';
begin
  if strpos(definition,completion)=0 or strpos(definition,cancellation)=0 then
    raise exception 'Supplier return workflow changed';
  end if;
  definition:=replace(definition,completion,
    'perform app.queue_supplier_return_message(i,btrim(p_note),p_request_id);'||chr(10)||'  '||completion);
  definition:=replace(definition,cancellation,$sql$
  update app.supplier_operations set status='failed',finished_at=clock_timestamp(),
    note='返品完了を取り消したため送信しませんでした'
  where item_id=i.id and status='queued' and return_tracking_no is not null;
  $sql$||cancellation);
  execute definition;
end $patch$;

notify pgrst,'reload schema';
