create table if not exists app.marketplace_purchase_leases (
  marketplace text primary key check (marketplace in ('メルカリ','ヤフオク','ヤフフリ','ラクマ')),
  owner_id uuid not null, expires_at timestamptz not null
);
alter table app.marketplace_purchase_leases enable row level security;
revoke all on app.marketplace_purchase_leases from anon;
grant select,insert,update,delete on app.marketplace_purchase_leases to authenticated;
create policy marketplace_purchase_leases_admin on app.marketplace_purchase_leases to authenticated using (app.is_admin()) with check (app.is_admin());
create or replace function app.marketplace_purchase_lease(p_marketplace text,p_owner uuid,p_action text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_site text:=case when p_marketplace='PayPayフリマ' then 'ヤフフリ' else p_marketplace end; held uuid;
begin
 if not app.is_admin() then raise exception '管理者権限が必要です'; end if;
 if v_site not in ('メルカリ','ヤフオク','ヤフフリ','ラクマ') or p_owner is null then raise exception '取得対象が不正です'; end if;
 if p_action='release' then delete from app.marketplace_purchase_leases where marketplace=v_site and owner_id=p_owner;return true;end if;
 if p_action<>'acquire' then raise exception '取得操作が不正です';end if;
 insert into app.marketplace_purchase_leases(marketplace,owner_id,expires_at) values(v_site,p_owner,now()+interval '2 minutes')
 on conflict(marketplace) do update set owner_id=excluded.owner_id,expires_at=excluded.expires_at
 where app.marketplace_purchase_leases.owner_id=p_owner or app.marketplace_purchase_leases.expires_at<now()
 returning owner_id into held;
 return held=p_owner;
end $$;
revoke all on function app.marketplace_purchase_lease(text,uuid,text) from public,anon;
grant execute on function app.marketplace_purchase_lease(text,uuid,text) to authenticated;
notify pgrst,'reload schema';