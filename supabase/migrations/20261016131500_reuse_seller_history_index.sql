-- The original seller migration already provides the same per-item history index.
-- Remove only the redundant index introduced by the shipping preferences migration.
drop index if exists app.seller_history_by_item;
