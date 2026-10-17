-- app.product_serial intentionally returns suffixes in upper case for accounting.
-- Marketplace parsers use lower case. Normalize both while preserving the whole suffix.
do $$declare d text;begin
 d:=pg_get_functiondef('app.resolve_seller_observation_item(text,jsonb)'::regprocedure);
 if strpos(d,'app.product_serial(sku,lot_seq)=serial')=0 then raise exception 'Expected serial comparison not found';end if;
 execute replace(d,'app.product_serial(sku,lot_seq)=serial','lower(app.product_serial(sku,lot_seq))=serial');
end $$;
notify pgrst,'reload schema';
