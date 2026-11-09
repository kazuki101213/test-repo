begin;

insert into app.staff(code, name, role, is_active) values ('ZX', '管理者テスト', 'admin', true);
insert into auth.users(id, email) values
  ('56565656-5656-5656-5656-565656565651', 'product-admin@example.com'),
  ('56565656-5656-5656-5656-565656565652', 'product-purchaser@example.com');
insert into app.profiles(user_id, staff_id)
select '56565656-5656-5656-5656-565656565651'::uuid, id from app.staff where code = 'ZX'
union all
select '56565656-5656-5656-5656-565656565652'::uuid, id from app.staff where code = 'EE';

insert into app.products(asin) values ('BCATOWN001');
set local role authenticated;
set local request.jwt.claim.sub = '56565656-5656-5656-5656-565656565651';
insert into app.products(asin) values ('BCATOWN002');

do $test$
declare original uuid := (select id from app.staff where code = 'AA');
        second_admin uuid := app.current_staff_id();
begin
  if (select owner_staff_id from app.products where asin = 'BCATOWN001') is distinct from original
     or (select owner_staff_id from app.products where asin = 'BCATOWN002') is distinct from second_admin then
    raise exception 'Both catalog lists must be visible to the second administrator and retain their owners';
  end if;
  begin
    update app.products set owner_staff_id = second_admin where asin = 'BCATOWN001';
    raise exception 'A normal update reassigned the product owner';
  exception when insufficient_privilege then null;
  end;
end $test$;

set local request.jwt.claim.sub = '56565656-5656-5656-5656-565656565652';
insert into app.products(asin) values ('BCATOWN003');
do $test$
begin
  if (select owner_staff_id from app.products where asin = 'BCATOWN003')
     is distinct from (select id from app.staff where code = 'AA') then
    raise exception 'Existing purchaser insert no longer defaults to the original catalog';
  end if;
end $test$;

rollback;
