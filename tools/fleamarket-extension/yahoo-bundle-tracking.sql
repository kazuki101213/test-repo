-- The same auction can represent several explicitly bundled main units.
-- Keep the existing duplicate check for all other matches.
do $migration$
declare
  definition text := pg_get_functiondef('app.reconcile_marketplace_tracking(app.marketplace,text,text,text,text,text)'::regprocedure);
  old_branch text := $old$  elsif v_count > 1 then
    v_status := '在庫ID重複';$old$;
  new_branch text := $new$  elsif v_count > 1 then
    if p_marketplace = 'ヤフオク' and p_confirmation_status is null
      and p_account_label in ('ヤフオク1', 'ヤフオク2')
      and v_site_no ~ '^[0-9]{8,20}$' then
      declare
        bundle_lots text[];
        bundle_skus text[];
        updated_rows integer;
      begin
        select array_agg(lot_seq::text order by lot_seq), array_agg(sku order by lot_seq)
        into bundle_lots, bundle_skus
        from app.items where marketplace = p_marketplace and marketplace_item_id = v_item_id;

        if (select count(distinct lot) from unnest(bundle_lots) as lot) = v_count
          and (select count(distinct purchaser_id) = 1 and count(distinct deliverer_id) = 1
            from app.items where marketplace = p_marketplace and marketplace_item_id = v_item_id)
          and not exists (
            select 1 from app.items i
            where i.marketplace = p_marketplace and i.marketplace_item_id = v_item_id
              and (i.is_accessory is distinct from false or i.purchaser_id is null or i.deliverer_id is null
                or not coalesce(app.receipt_bundle_lots(i.memo) @> bundle_lots
                  and bundle_lots @> app.receipt_bundle_lots(i.memo), false)
                or (nullif(btrim(i.tracking_no), '') is not null
                  and regexp_replace(i.tracking_no, '[[:space:]－-]', '', 'g') <> v_site_no))
          ) then
          update app.items set tracking_no = v_site_no
          where marketplace = p_marketplace and marketplace_item_id = v_item_id
            and nullif(btrim(tracking_no), '') is null;
          get diagnostics updated_rows = row_count;

          update app.marketplace_tracking_tasks set state = '確認済み', updated_at = now()
          where marketplace = p_marketplace and marketplace_item_id = v_item_id
            and account_label = p_account_label and state = '未確認'
            and confirmation_status in ('追跡番号不一致','在庫未一致','在庫ID重複','追跡番号未取得','追跡番号記載なし');
          return jsonb_build_object('result', case when updated_rows > 0 then 'updated' else 'already_matched' end,
            'sku', bundle_skus[1], 'skus', bundle_skus, 'tracking_no', v_site_no, 'updated_count', updated_rows);
        end if;
      end;
    end if;
    v_status := '在庫ID重複';$new$;
begin
  if strpos(definition, new_branch) > 0 then return; end if;
  if strpos(definition, old_branch) = 0 then
    raise exception 'Marketplace tracking duplicate branch has changed';
  end if;
  execute replace(definition, old_branch, new_branch);
end;
$migration$;
