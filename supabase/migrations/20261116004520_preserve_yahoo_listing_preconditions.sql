-- Preserve the established account, photo approval, and state checks before
-- validating the Yahoo shipping policy in the listing queue.
do $migration$
declare
 definition text:=pg_get_functiondef('app.queue_seller_operation(uuid,text,jsonb,uuid)'::regprocedure);
 policy text:=$body$    IF i.sales_channel = 'ヤフオク' THEN
      DECLARE
        validation_error text := app.yahoo_listing_shipping_error(i.id,p_payload);
      BEGIN
        IF validation_error IS NOT NULL THEN
          RAISE EXCEPTION USING message=validation_error,errcode='22023';
        END IF;
      END;
    END IF;$body$;
 anchor text:=$body$    IF i.status <> '商品登録前' THEN RAISE EXCEPTION '商品登録前の商品だけ出品できます'; END IF;$body$;
begin
 if strpos(definition,policy||E'\n')=0 or strpos(definition,anchor)=0 then
  raise exception 'seller queue preconditions or Yahoo guard missing';
 end if;
 definition:=replace(definition,policy||E'\n','');
 execute replace(definition,anchor,anchor||E'\n'||policy);
end;
$migration$;
