-- 管理アプリで販売状態を「受取前」に戻せるようにする（2026-11-21 ユーザー指定、例：1330）。
-- これまでは受取前を選んでも、検品日などの記録から状態が計算し直され「商品登録前」に戻っていた。
-- ・手で受取前にしたとき（トリガーの入れ子でない更新）は検品日・商品登録日を空にして受取前にする。
-- ・その後は追跡番号が変わるまで受取前のまま（追跡番号を登録し直すと従来どおり検品中へ進む）。
-- 付属品の追跡番号待ちで本体を止める／解除する処理（別の行のトリガーから呼ばれる入れ子の更新）は従来どおり。
do $patch$
declare
  definition text := pg_get_functiondef('app.items_sync_status()'::regprocedure);
  old_explicit constant text := $old$elsif new.status in ('取引中','Amazon補填申請中') then return new;$old$;
  new_explicit constant text := $new$elsif new.status='受取前' and pg_trigger_depth()=1 then
     new.inspected_at:=null;new.product_registered_at:=null;return new;
   elsif new.status in ('取引中','Amazon補填申請中') then return new;$new$;
  old_tracking constant text := $old$ elsif nullif(btrim(new.tracking_no),'') is not null then new.status:='検品中';$old$;
  new_tracking constant text := $new$ elsif nullif(btrim(new.tracking_no),'') is not null
   and not (tg_op='UPDATE' and pg_trigger_depth()=1 and old.status='受取前'
     and new.tracking_no is not distinct from old.tracking_no) then new.status:='検品中';$new$;
begin
  if strpos(definition, old_explicit)=0 or strpos(definition, old_tracking)=0 then
    raise exception 'items_sync_status changed unexpectedly';
  end if;
  execute replace(replace(definition, old_explicit, new_explicit), old_tracking, new_tracking);
end
$patch$;
