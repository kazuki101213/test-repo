-- Real parent-redirection, SKU, alias and inventory triggers. All fixtures roll back.
begin;
create temporary table usage_probe(source uuid,target uuid,child uuid,foreign_body uuid,source_before jsonb,target_before jsonb,child_before jsonb,owner_user uuid,other_user uuid,revision timestamptz);
grant select,update on usage_probe to authenticated;
do $$
declare aa uuid;dd uuid;hh uuid;a uuid;b uuid;c uuid;f uuid;s uuid;
begin
 select id into aa from app.staff where code='AA';
 select id into dd from app.staff where code='DD';
 select id into hh from app.staff where code='HH';
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no)
 values(995101,aa,dd,'2026-10-01','usage original body',7250,'ヤフオク','original tracking') returning id into a;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no)
 values(995102,aa,dd,'2026-10-02','usage target body',5000,'メルカリ','target tracking') returning id into b;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,tracking_no)
 values(995103,aa,hh,'2026-10-02','usage foreign body',3000,'メルカリ','foreign tracking') returning id into f;
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,marketplace_item_id,tracking_no,is_accessory,parent_item_id)
 values(995101,aa,dd,'2026-09-20','usage remote',1610,'メルカリ','usage-remote-order','remote tracking',true,a) returning id into c;
 -- Another identical-purchase accessory already occupies the target's plain SKU.
 insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,is_accessory,parent_item_id)
 values(995102,aa,dd,'2026-09-20','existing target remote',1610,'メルカリ',true,b);
 insert into app.item_photos(item_id,storage_path) values(c,'usage-test/remote.jpg');
 insert into app.spare_accessories(owner_staff_id,title,cost_amount) values(aa,'usage spare',1610) returning id into s;
 update app.spare_accessories set used_for_item_id=c where id=s;
 insert into app.spare_shipping_tasks(spare_id,item_id,accessory_item_id,owner_staff_id,recipient_staff_id,title,lot_seq)
 values(s,a,c,aa,dd,'usage remote',995101);
 insert into usage_probe select a,b,c,f,(select to_jsonb(i) from app.items i where id=a),(select to_jsonb(i) from app.items i where id=b),to_jsonb(i),
  (select user_id from app.profiles where staff_id=dd),(select user_id from app.profiles where staff_id=hh),i.updated_at from app.items i where id=c;
end $$;
set local role authenticated;
do $$
declare p usage_probe;r jsonb;page jsonb;
begin
 select * into p from usage_probe;
 perform set_config('request.jwt.claim.sub',p.owner_user::text,true);
 r:=app.accessory_usage_context(p.child);
 if r->>'serial'<>'995101' then raise exception 'Original usage not read';end if;
 r:=app.reassign_accessory_usage(p.child,'995102',p.revision);
 if r->>'serial'<>'995102' or r->>'item_id'<>p.child::text then raise exception 'Transfer changed identity';end if;
 if not exists(select 1 from app.items where id=p.child and parent_item_id=p.target and lot_seq=995102 and app.product_serial(sku,lot_seq)='995102a') then raise exception 'Usage did not move safely past SKU collision';end if;
 if (select to_jsonb(i) from app.items i where id=p.source) is distinct from p.source_before
  or (select to_jsonb(i) from app.items i where id=p.target) is distinct from p.target_before then raise exception 'Transfer corrupted a parent';end if;
 if (select to_jsonb(i)-array['parent_item_id','lot_seq','sku','status','packed_on','shipped_on','returned_on','sales_channel','condition','sold_on','sold_price','payout_amount','updated_at'] from app.items i where id=p.child)
  is distinct from p.child_before-array['parent_item_id','lot_seq','sku','status','packed_on','shipped_on','returned_on','sales_channel','condition','sold_on','sold_price','payout_amount','updated_at'] then raise exception 'Purchase identity/history changed';end if;
 if not exists(select 1 from app.item_photos where item_id=p.child and storage_path='usage-test/remote.jpg') then raise exception 'Photo lost';end if;
 page:=app.read_inventory_page('delivery','{"queryField":"serial","query":"995102"}',10,'{}');
 if not exists(select 1 from jsonb_array_elements(page->'rows') x where x->>'id'=p.child::text and x->>'inventory_group_serial'='995102') then raise exception 'Inventory did not regroup';end if;
 begin
  perform app.reassign_accessory_usage(p.child,'995101',p.revision-interval '1 second');
  raise exception 'Stale revision accepted';
 exception when serialization_failure then null;end;
 begin
  perform app.reassign_accessory_usage(p.child,'995103',(select updated_at from app.items where id=p.child));
  raise exception 'Foreign destination accepted';
 exception when insufficient_privilege then null;end;
 begin
  perform app.reassign_accessory_usage(p.source,'995102',(select updated_at from app.items where id=p.source));
  raise exception 'Body accepted';
 exception when raise_exception then if sqlerrm='Body accepted' then raise;end if;end;
 begin
  perform app.reassign_accessory_usage(p.child,'995199',(select updated_at from app.items where id=p.child));
  raise exception 'Missing destination accepted';
 exception when raise_exception then if sqlerrm='Missing destination accepted' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',p.other_user::text,true);
 begin
  perform app.accessory_usage_context(p.child);
  raise exception 'Foreign owner could read';
 exception when insufficient_privilege then null;end;
 begin
  perform app.reassign_accessory_usage(p.child,'995103',p.revision);
  raise exception 'Foreign owner could write';
 exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$declare p usage_probe;begin
 select * into p from usage_probe;
 if not exists(select 1 from app.item_sku_aliases where item_id=p.child and sku=p.child_before->>'sku') then raise exception 'Original SKU history lost';end if;
 if not exists(select 1 from app.spare_shipping_tasks where accessory_item_id=p.child and item_id=p.target and lot_seq=995102) then raise exception 'Pending spare destination stale';end if;
 if not exists(select 1 from app.spare_accessories where used_for_item_id=p.child) then raise exception 'Spare identity lost';end if;
 if has_function_privilege('anon','app.reassign_accessory_usage(uuid,text,timestamptz)','execute') then raise exception 'Anonymous write exposed';end if;
 -- Repeated save is harmless, and completed products cannot be reassigned.
 perform set_config('request.jwt.claim.sub',p.owner_user::text,true);
 perform app.reassign_accessory_usage(p.child,'995102',(select updated_at from app.items where id=p.child));
 update app.items set shipped_on=current_date where id=p.target;
 begin
  perform app.reassign_accessory_usage(p.child,'995101',(select updated_at from app.items where id=p.child));
  raise exception 'Shipped accessory moved';
 exception when raise_exception then if sqlerrm='Shipped accessory moved' then raise;end if;end;
end $$;
rollback;
