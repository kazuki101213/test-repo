-- Approval is mandatory for listing, independent of the legacy packing gate.
create function app.listing_photos_approved(p_item_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from app.photo_reviews r where r.item_id=p_item_id
  and r.approved_at is not null and r.exported_photo_count=(
   select count(*) from app.item_photos p where p.item_id=p_item_id and p.photo_kind='product'));
$$;
revoke all on function app.listing_photos_approved(uuid) from public,anon;
grant execute on function app.listing_photos_approved(uuid) to authenticated,service_role;

-- Append to the existing invoker view so page revisions also change on approval.
do $$ declare definition text; patched text; begin
 definition:=rtrim(pg_get_viewdef('app.v_delivery_tasks'::regclass,true),E';\n ');
 execute 'create or replace view app.v_delivery_tasks with(security_invoker=true) as select v.*,app.listing_photos_approved(v.id) as photo_review_approved from ('||definition||') v';

 definition:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(definition,'when ''listing_complete'' then','when ''listing_complete'' then
  if not app.listing_photos_approved(i.id) then raise exception ''管理アプリで商品写真の承認が必要です'' using errcode=''42501'';end if;');
 if patched=definition then raise exception 'listing_complete gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 patched:=replace(definition,'if p_kind=''listing'' then','if p_kind=''listing'' then
  if not app.listing_photos_approved(i.id) then raise exception ''管理アプリで商品写真の承認が必要です'' using errcode=''42501'';end if;');
 if patched=definition then raise exception 'listing queue gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.extension_claim_seller_operation(uuid,text)'::regprocedure);
 patched:=replace(definition,'and i.sold_on is null','and i.sold_on is null and (app.seller_operations.kind<>''listing'' or app.listing_photos_approved(i.id))');
 if patched=definition then raise exception 'listing claim gate anchor missing';end if;
 execute patched;

 definition:=pg_get_functiondef('app.seller_operation_context(uuid)'::regprocedure);
 patched:=replace(definition,'''revision'',i.updated_at','''photo_review_approved'',app.listing_photos_approved(i.id),''revision'',i.updated_at');
 if patched=definition then raise exception 'seller context anchor missing';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';
