begin;
do $test$
declare aa uuid; holder uuid; draft uuid; spare uuid; again uuid; failed_draft uuid; rejected boolean:=false; payload jsonb;
begin
 select id into aa from app.staff where code='AA';
 select id into holder from app.staff where code='HH';
 perform set_config('request.jwt.claim.sub',(select user_id::text from app.profiles where staff_id=aa limit 1),true);
 insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,purchased_at,cost_amount)
 values('メルカリ','spare-draft-fixture','https://jp.mercari.com/item/spare-draft-fixture','fixture','TOSHIBA SE-R0435','2026-10-25',1800) returning id into draft;
 insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title)
 values('ヤフオク','spare-draft-failure','https://auctions.yahoo.co.jp/jp/auction/spare-draft-failure','fixture','remote') returning id into failed_draft;
 payload:=jsonb_build_object('owner_staff_id',holder,'title','リモコン','manufacturer','TOSHIBA','purchased_at','2026-10-25','cost_amount',1800);
 set local role authenticated;
 spare:=app.register_purchase_draft_spare(draft,payload);
 again:=app.register_purchase_draft_spare(draft,payload);
 if spare is distinct from again then raise exception 'Retry created a duplicate spare';end if;
 if not exists(select 1 from app.marketplace_purchase_drafts where id=draft and state='registered' and registered_spare_id=spare and registered_item_id is null)
 then raise exception 'Draft was not atomically registered as a spare';end if;
 if not exists(select 1 from app.spare_accessories where id=spare and owner_staff_id=holder and title='リモコン' and manufacturer='TOSHIBA'
   and purchased_at='2026-10-25' and cost_amount=1800 and marketplace='メルカリ' and marketplace_item_id='spare-draft-fixture' and usage_note is null and source_sku is null)
 then raise exception 'Purchase metadata or blank usage was lost';end if;
 if exists(select 1 from app.items where source_purchase_draft_id=draft or marketplace_item_id='spare-draft-fixture') then raise exception 'Unexpected inventory was created';end if;
 begin perform app.register_purchase_draft_spare(failed_draft,payload||'{"cost_amount":-1}'::jsonb);
 exception when invalid_parameter_value then rejected:=true;end;
 if not rejected or not exists(select 1 from app.marketplace_purchase_drafts where id=failed_draft and state='draft' and registered_spare_id is null)
 then raise exception 'Failed registration removed the draft';end if;
 reset role;
 if exists(select 1 from app.spare_accessories where marketplace_item_id='spare-draft-failure') then raise exception 'Failed registration left a partial spare';end if;
 perform set_config('request.jwt.claim.sub','',true);
 rejected:=false;
 set local role authenticated;
 begin perform app.register_purchase_draft_spare(failed_draft,payload);exception when insufficient_privilege then rejected:=true;end;
 if not rejected then raise exception 'Unauthenticated registration was allowed';end if;
end $test$;
rollback;
