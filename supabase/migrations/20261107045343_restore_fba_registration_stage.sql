-- Amazon offer/photo verification is not completion of the FBA inbound work.
-- Guard the database too, including requests from an older Edge deployment.
-- The existing explicit inventory workflow remains separate from this automatic RPC.
do $$declare original text;patched text;begin
 original:=pg_get_functiondef('app.complete_verified_amazon_listing(uuid,text)'::regprocedure);
 patched:=replace(original,' perform app.validate_work_completion_date(r.work_completed_on,i.purchased_at);',
  E' if app.sales_channel_family(i.sales_channel)=''FBA'' then return;end if;\n perform app.validate_work_completion_date(r.work_completed_on,i.purchased_at);');
 if patched=original then raise exception 'Amazon completion date anchor missing';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';
