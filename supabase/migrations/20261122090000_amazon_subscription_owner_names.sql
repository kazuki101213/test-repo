-- Amazon大口の経費名をアカウントの持ち主名にする（2026-11-22 ユーザー指定）。
-- ・1アカ目は小口にしたので、残っていた10月・11月の入力待ちは消す（ユーザー了承済み）。
--   月末の自動作成（generate_next_month_fixed_expenses）は当月の経費と未入力の入力待ちを翌月に引き継ぐので、
--   入力待ちを消せば1アカ目の入力待ちは今後作られない。
-- ・(1アカ目) → (長部一輝)、(2アカ目) と Amazon2 から自動で入れた「Amazon大口」→ (石嶋俊紀)。
update app.expense_drafts set deleted_at = now()
 where deleted_at is null and category = '固定費' and name = 'Amazon大口(1アカ目)';
update app.expenses set name = 'Amazon大口(長部一輝)' where name = 'Amazon大口(1アカ目)';
update app.expenses set name = 'Amazon大口(石嶋俊紀)'
 where name = 'Amazon大口(2アカ目)' or (name = 'Amazon大口' and memo like 'Amazon2 /%');
update app.expense_drafts set name = 'Amazon大口(石嶋俊紀)' where deleted_at is null and name = 'Amazon大口(2アカ目)';

-- 今後Amazonの請求から自動で入れる大口も、アカウントごとに持ち主名で入れる。
do $patch$
declare
  definition text := pg_get_functiondef('app.apply_amazon_service_fee_expenses(text,text,text[],text)'::regprocedure);
  old_name constant text := $o$expense_name := 'Amazon大口';$o$;
  new_name constant text := $n$expense_name := case p_account_label when 'Amazon1' then 'Amazon大口(長部一輝)' else 'Amazon大口(石嶋俊紀)' end;$n$;
  old_candidates constant text := $o$candidate_names := array[expense_name, 'Amazon大口(1アカ目)',$o$;
  new_candidates constant text := $n$candidate_names := array[expense_name, 'Amazon大口', 'Amazon大口(1アカ目)',$n$;
begin
  if strpos(definition, old_name)=0 or strpos(definition, old_candidates)=0 then
    raise exception 'apply_amazon_service_fee_expenses changed unexpectedly';
  end if;
  execute replace(replace(definition, old_name, new_name), old_candidates, new_candidates);
end
$patch$;
notify pgrst, 'reload schema';
