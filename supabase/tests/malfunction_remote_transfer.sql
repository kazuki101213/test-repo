-- Disposable fixtures: exercise the actual reply RPC and trigger together.
begin;
set local role authenticated;
set local request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
do $$
declare kind text; seq integer:=997600; body uuid; remote uuid; remote_sku text; reply uuid;
 buyer uuid; holder uuid; existing_count bigint;
begin
 select id into buyer from app.staff where code='AA';
 select id into holder from app.staff where code='MM';
 foreach kind in array array['Panasonic◯ヤフオク','Panasonic×ヤフオク','SONY◯ヤフオク','SONY×ヤフオク',
   'SHARP◯ヤフオク','SHARP×ヤフオク','TOSHIBA◯ヤフオク','TOSHIBA×ヤフオク','ヤフオク その他','仕入先確認'] loop
  seq:=seq+1;
  insert into app.items(lot_seq,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status,malfunction_reported,condition)
  values(seq,buyer,holder,current_date,'reply remote fixture',1000,'メルカリ','メルカリ','動作不良',true,'非常に良い') returning id into body;
  insert into app.items(lot_seq,parent_item_id,is_accessory,purchaser_id,deliverer_id,purchased_at,title,cost_amount,marketplace,sales_channel,status)
  values(seq,body,true,buyer,holder,current_date,'リモコン',770,'メルカリ','メルカリ','動作不良') returning id,sku into remote,remote_sku;
  reply:=gen_random_uuid();
  perform app.send_malfunction_reply(reply,body,'fixture only',kind,'{}');
  perform app.send_malfunction_reply(reply,body,'fixture only',kind,'{}');
  if kind in ('ヤフオク その他','仕入先確認') then
   if not exists(select 1 from app.items where id=remote) then raise exception 'Keep-accessories template moved remote: %',kind;end if;
   if exists(select 1 from app.spare_accessories where usage_note=seq::text) then raise exception 'Unexpected spare: %',kind;end if;
  else
   if exists(select 1 from app.items where id=remote) then raise exception 'Registered remote was not moved: %',kind;end if;
   select count(*) into existing_count from app.spare_accessories where usage_note=seq::text;
   if existing_count<>1 then raise exception 'Remote missing or duplicated: %',kind;end if;
   if not exists(select 1 from app.spare_accessories where usage_note=seq::text and source_sku=remote_sku and cost_amount=770 and owner_staff_id=holder) then
    raise exception 'Remote identity/cost/holder changed: %',kind;
   end if;
   if not exists(select 1 from app.items where id=body and sales_channel='ヤフオク' and status='商品登録前' and workflow_previous_sales_channel='メルカリ') then
    raise exception 'Body transition or original sales channel lost: %',kind;
   end if;
  end if;
 end loop;
end $$;
rollback;
