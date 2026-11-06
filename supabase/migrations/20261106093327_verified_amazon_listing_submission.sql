-- Amazon may be accepted asynchronously. Only server-verified evidence can finish listing.
create table app.amazon_listing_submissions (
 request_id uuid primary key,
 item_id uuid not null references app.items(id),
 requested_by uuid not null references auth.users(id),
 sku text not null, asin text not null, sales_channel app.sales_channel not null,
 account_id text not null check(account_id in ('amazon-1','amazon-2')),
 seller_id text not null, price bigint not null check(price>0),
 item_condition text not null, description text not null,
 work_completed_on date not null,
 state text not null check(state in ('submitting','accepted','uncertain','failed','verified')),
 submission_id text, note text not null default '',
 created_at timestamptz not null default clock_timestamp(),
 verified_at timestamptz
);
create unique index amazon_listing_one_pending on app.amazon_listing_submissions(item_id) where state in ('submitting','accepted','uncertain');
create index amazon_listing_item_history on app.amazon_listing_submissions(item_id,created_at desc);
alter table app.amazon_listing_submissions enable row level security;
revoke all on app.amazon_listing_submissions from public,anon,authenticated;
grant select on app.amazon_listing_submissions to authenticated;
grant all on app.amazon_listing_submissions to service_role;
create policy amazon_listing_assignee_read on app.amazon_listing_submissions for select to authenticated
 using(exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id())));
create policy amazon_listing_service on app.amazon_listing_submissions for all to service_role using(true) with check(true);

-- Existing manual callers and stale app tabs cannot claim an Amazon submission succeeded.
do $patch$
declare original text; patched text;
begin
 original:=pg_get_functiondef('app.perform_inventory_action(uuid,text,app.item_status,text,uuid)'::regprocedure);
 patched:=replace(original, E'when ''listing_complete'' then\n', E'when ''listing_complete'' then\n  if not exists(select 1 from app.amazon_listing_submissions s where s.request_id=p_request_id and s.item_id=i.id and s.state=''verified'' and s.verified_at>clock_timestamp()-interval ''10 minutes'' and s.sku=i.sku and s.asin=btrim(i.asin::text) and s.sales_channel=i.sales_channel and s.price=i.planned_price and s.item_condition=i.condition::text and s.description=coalesce(i.description,'''') and s.seller_id=case when i.sales_channel::text in (''FBA2'',''自己発送2'') then ''A3E7BXJWH9TP11'' else ''A1WI3OGPE43N2T'' end) then raise exception ''Amazonへの登録を確認できていません。出品画面から登録結果を確認してください'' using errcode=''42501'';end if;\n');
 if patched=original then raise exception 'Amazon listing confirmation anchor missing';end if;
 execute patched;
end $patch$;
