-- =============================================================================
-- ログインアカウントと担当者の紐付け
--
--   Supabase の Authentication で作ったアカウントを、app.staff の誰かに結びつける。
--   紐付いていないアカウントはログインしてもアプリを開けない（意図的な作り）。
--
--   使い方（SQL Editor で実行）
--     select app.link_login('kubota@example.com', 'DD');
-- =============================================================================

create or replace function app.link_login(p_email text, p_staff_code text)
returns text
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_user     uuid;
  v_staff    uuid;
  v_name     text;
  v_role     app.staff_role;
  v_email    text := lower(btrim(p_email));
  v_code     text := upper(btrim(p_staff_code));
begin
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    raise exception 'メールアドレス % のアカウントが見つかりません', v_email
      using hint = 'Supabase の Authentication → Users → Add user で、'
                   'このメールアドレスのアカウントを先に作ってください。';
  end if;

  select id, name, role into v_staff, v_name, v_role from app.staff where code = v_code;
  if v_staff is null then
    raise exception '担当者コード % が見つかりません', v_code
      using hint = 'select code, name from app.staff order by code; で一覧を確認できます。';
  end if;

  -- 同じ担当者に別のアカウントが紐付いていたら、新しいほうに付け替える
  delete from app.profiles where staff_id = v_staff and user_id <> v_user;

  insert into app.profiles (user_id, staff_id)
  values (v_user, v_staff)
  on conflict (user_id) do update set staff_id = excluded.staff_id;

  update app.staff set email = v_email where id = v_staff;

  return format('%s（%s / %s）を %s に紐付けました', v_name, v_code, v_role, v_email);
end;
$$;

comment on function app.link_login is
  'Authentication のアカウントを app.staff に紐付ける。SQL Editor から select app.link_login(メール, コード); で使う。';

-- -----------------------------------------------------------------------------
-- 紐付けの一覧（誰がログインできるか）
-- -----------------------------------------------------------------------------
create or replace view app.v_logins with (security_invoker = on) as
select
  s.code,
  s.name       as 担当者,
  s.role       as 役割,
  s.is_active  as 在籍,
  s.email,
  (p.user_id is not null) as ログイン可能
from app.staff s
left join app.profiles p on p.staff_id = s.id
order by s.code;

grant select on app.v_logins to authenticated;
