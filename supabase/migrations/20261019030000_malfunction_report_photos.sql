-- Private Drive attachments are staged before the existing report transition commits.
create table app.malfunction_report_photos (
 id uuid primary key, item_id uuid not null references app.items(id) on delete cascade,
 request_id uuid not null, uploaded_by uuid not null references app.staff(id),
 drive_file_id text not null check (drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 sort_order integer not null check(sort_order between 0 and 9),
 event_id uuid references app.inventory_workflow_events(id), created_at timestamptz not null default now(),
 unique(request_id,sort_order)
);
create index malfunction_report_photos_item_event on app.malfunction_report_photos(item_id,event_id,sort_order);
alter table app.malfunction_report_photos enable row level security;
revoke all on app.malfunction_report_photos from public,anon,authenticated;
grant select on app.malfunction_report_photos to authenticated;
grant all on app.malfunction_report_photos to service_role;
create policy malfunction_report_photos_read on app.malfunction_report_photos for select to authenticated using(
 event_id is not null and exists(select 1 from app.staff where id=app.current_staff_id() and is_active)
 and exists(select 1 from app.items i where i.id=item_id and (app.is_admin() or i.deliverer_id=app.current_staff_id() or (app.current_role()='purchaser' and i.purchaser_id=app.current_staff_id())))
);

create function app.submit_malfunction_report(p_item_id uuid,p_expected_status app.item_status,p_note text,p_request_id uuid,p_photo_ids uuid[])
returns void language plpgsql security definer set search_path=pg_catalog,app as $$
declare actor uuid:=app.current_staff_id(); n integer;
begin
 if auth.uid() is null or actor is null or not exists(select 1 from app.staff where id=actor and is_active) then raise exception 'ログインが必要です' using errcode='42501';end if;
 if coalesce(cardinality(p_photo_ids),0) not between 1 and 10 or (select count(distinct id) from unnest(p_photo_ids) id)<>cardinality(p_photo_ids) then raise exception '写真は1〜10枚で指定してください' using errcode='22023';end if;
 -- Lock all attachments so their identity and ownership cannot change during submission.
 perform 1 from app.malfunction_report_photos where id=any(p_photo_ids) and item_id=p_item_id and request_id=p_request_id and uploaded_by=actor for update;
 select count(*) into n from app.malfunction_report_photos where id=any(p_photo_ids) and item_id=p_item_id and request_id=p_request_id and uploaded_by=actor and (event_id is null or event_id=p_request_id);
 if n<>cardinality(p_photo_ids) then raise exception '報告写真の保存を確認できません' using errcode='42501';end if;
 perform app.perform_inventory_action(p_item_id,'report',p_expected_status,p_note,p_request_id);
 update app.malfunction_report_photos set event_id=p_request_id where id=any(p_photo_ids);
end $$;
revoke all on function app.submit_malfunction_report(uuid,app.item_status,text,uuid,uuid[]) from public,anon;
grant execute on function app.submit_malfunction_report(uuid,app.item_status,text,uuid,uuid[]) to authenticated;

create function app.read_malfunction_report_photos(p_item_id uuid)
returns table(id uuid,drive_file_id text,sort_order integer) language sql stable security invoker set search_path=pg_catalog,app as $$
 select p.id,p.drive_file_id,p.sort_order from app.malfunction_report_photos p
 where p.item_id=p_item_id and p.event_id=(select e.id from app.inventory_workflow_events e where e.item_id=p_item_id and e.action='report' order by e.created_at desc limit 1)
 order by p.sort_order,p.id
$$;
revoke all on function app.read_malfunction_report_photos(uuid) from public,anon;
grant execute on function app.read_malfunction_report_photos(uuid) to authenticated;
notify pgrst,'reload schema';
