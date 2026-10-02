-- Evaluate stable identity lookups once per statement instead of once per row.
-- This preserves the existing access rules while keeping authenticated inventory
-- queries fast as the number of inventory rows grows.
drop policy if exists items_select on app.items;
create policy items_select on app.items
  for select to authenticated
  using (
    (select app."current_role"()) = any(array['admin'::app.staff_role, 'purchaser'::app.staff_role])
    or deliverer_id = (select app.current_staff_id())
  );

drop policy if exists item_comments_select on app.item_comments;
create policy item_comments_select on app.item_comments
  for select to authenticated
  using (
    exists (
      select 1 from app.items i
      where i.id = item_comments.item_id
        and (
          (select app."current_role"()) = any(array['admin'::app.staff_role, 'purchaser'::app.staff_role])
          or i.deliverer_id = (select app.current_staff_id())
        )
    )
  );
