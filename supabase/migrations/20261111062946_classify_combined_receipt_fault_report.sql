-- One report can describe both the main unit and its remote.
create function app.receipt_fault_report_scope(p_report text)
returns text language sql immutable security invoker set search_path='' as $$
 with sentences as (
   select btrim(sentence) as text
   from regexp_split_to_table(lower(normalize(coalesce(p_report,''),NFKC)), '[。！？!?\n\r;；]+') sentence
 ), observations as (
   select
     text ~ '(本体|hdd|ハードディスク|ディスクドライブ|bdドライブ|dvdドライブ|hdmi端子|チューナー|レコーダー|ディスク|ドライブ)' as body_part,
     (text ~ '(でき(ない|ません|なかった|なく)|出来(ない|ません|なかった|なく)|し(ません|ない|なかった|なく)|なりません|ならない|ならなく|落ち(る|ます|た)|エラー(が|は)?(出|表示|に)|エラーです|不良(です|あり)|故障(です|し)|破損(です|し)|止まり|止まる|止まって|読めな|読み込めな|出ない|入らない|入りません)'
       and text !~ '(エラー|不良|故障|破損)(は|が)?(ありません|ない|なし|出ません|出ない)') as fault,
     text ~ '(リモコン|リモートコントロール|remote control)' as mentions_remote,
     text ~ '(リモコン|リモートコントロール|remote control)(自体|側|のボタン|の一部|の電池端子)?[がはも：:]?\s*(反応し(ません|ない)|動(きません|かない)|作動し(ません|ない)|使え(ない|ません)|効(かない|きません)|壊れ|故障|不良|破損|欠品|なし|がない|電池漏れ|液漏れ|電池を入れても反応し(ません|ない))' as remote_fault,
     text ~ '^(リモコン|リモートコントロール|remote control)(自体|側)?[がはも：:]?\s*(正常(です|に動作(します|しました))?|動作確認済み(です)?|問題(は|が)?(ありません|ない)|問題なし|操作(が|は)?(できます|できました)|反応(します|しました)|使え(ます|ました))[。．]?\s*$' as remote_normal
   from sentences
 ), summary as (
   select coalesce(bool_or(body_part and fault and (not mentions_remote or remote_fault)),false) as body_fault,
          coalesce(bool_or(remote_fault),false) as remote_fault,
          coalesce(bool_or(mentions_remote and not remote_normal),false) as unresolved_remote_mention
   from observations
 )
 select case
   when body_fault and remote_fault then 'both'
   when remote_fault then 'remote'
   when body_fault and not unresolved_remote_mention then 'body'
   else 'unclear'
 end
 from summary
$$;
revoke all on function app.receipt_fault_report_scope(text) from public,anon;
grant execute on function app.receipt_fault_report_scope(text) to authenticated,service_role;

CREATE OR REPLACE FUNCTION app.marketplace_receipt_context(p_marketplace app.marketplace, p_item_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'app', 'public'
AS $function$
declare
  v_probe jsonb;
  v_items jsonb;
  v_group_ok boolean;
  v_source_ready boolean;
  v_representative jsonb;
  v_skus jsonb;
  v_count integer;
  v_unallocated_count integer;
begin
  v_probe=app.marketplace_extension_probe(p_marketplace,p_item_id);

  select coalesce(jsonb_agg(e.value || jsonb_build_object(
    'receipt_ready', readiness.source is not null,
    'receipt_source', readiness.source,
    'receipt_report_scope', report.scope,
    'receipt_parent_sku', case when i.is_accessory and p.id is not null and not p.is_accessory then p.sku else null end
  ) order by i.id),'[]'::jsonb) into v_items
  from jsonb_array_elements(v_probe->'items') e(value)
  join app.items i on i.id=(e.value->>'id')::uuid
  left join app.items p on i.is_accessory and p.id=i.parent_item_id
  cross join lateral (
    select case
      when p_marketplace='ヤフオク' and i.is_accessory and i.title ilike '%リモコン%'
        and not p.is_accessory and p.status='動作不良' and p.malfunction_reported_at is not null
        and nullif(btrim(i.marketplace_item_id),'') is not null
        and i.marketplace_item_id is distinct from p.marketplace_item_id
      then app.receipt_fault_report_scope(p.malfunction_comment)
    end as scope
  ) report
  cross join lateral (
    select case
      when report.scope in ('remote','both') then null
      when p_marketplace='ヤフオク' and app.receipt_contact_disposition_ready(i) then 'disposition'
      when i.inspected_at is not null and (report.scope is null or i.inspected_at>p.malfunction_reported_at) then 'own'
      when i.is_accessory and not p.is_accessory
        and p.inspected_at is not null and report.scope is null then 'parent'
      when report.scope='body' and not i.malfunction_reported and i.malfunction_reported_at is null
        and i.title !~ '(作動しない|動作不良|不動|反応しない|故障|破損)' then 'accessory_approved'
      when p_marketplace='ヤフオク' and app.receipt_contact_accessory_approved(i,p) then 'accessory_approved'
    end as source
  ) readiness;

  if p_marketplace='ヤフオク' and exists (
    with matching_items as materialized (
      select i as inventory_item
      from jsonb_array_elements(v_items) e(value)
      join app.items i on i.id=(e.value->>'id')::uuid
    )
    select 1 from matching_items
    where app.receipt_bundle_is_waiting(inventory_item)
  ) then
    -- Older extensions use the timestamps as a fallback eligibility signal.
    select jsonb_agg((e.value - 'inspected_at') ||
      jsonb_build_object('receipt_ready',false,'receipt_source',null) order by e.ordinality)
      into v_items from jsonb_array_elements(v_items) with ordinality e(value,ordinality);
    return v_probe || jsonb_build_object('items',v_items,'receipt_bundle_waiting',true);
  end if;

  v_count=jsonb_array_length(v_items);
  if p_marketplace='ヤフオク' and v_count between 2 and 40 then
    with members as (
      select e.value,i.is_accessory,
        coalesce((e.value->>'receipt_ready')::boolean,false) as ready,
        i.is_accessory and i.parent_item_id is not null and exists(
          select 1 from app.spare_accessories s
          where s.marketplace_item_id=p_item_id and s.marketplace='ヤフオク'
          and (s.used_for_item_id=i.parent_item_id or exists(
            select 1 from app.spare_shipping_tasks t
            where t.spare_id=s.id and t.accessory_item_id=i.id and t.item_id=i.parent_item_id
          ))
        ) as allocated
      from jsonb_array_elements(v_items) e(value)
      join app.items i on i.id=(e.value->>'id')::uuid
    )
    select bool_and(ready or allocated),
      bool_or(ready and not allocated),
      jsonb_agg(value->>'sku' order by value->>'sku'),
      count(*) filter (where not allocated),
      (select value from members where not allocated order by is_accessory,value->>'id' limit 1)
      into v_group_ok,v_source_ready,v_skus,v_unallocated_count,v_representative
    from members;

    -- A single unallocated row identifies the transaction source even if
    -- inspection/cleaning is incomplete. Readiness is still enforced by the
    -- extension's eligibility check before any rating can be sent.
    if v_unallocated_count=1 and v_representative is not null then
      return v_probe || jsonb_build_object(
        'inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),
        'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,
        'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation'
      );
    end if;

    if v_group_ok and v_source_ready and v_representative is not null then
      return v_probe || jsonb_build_object(
        'inventory_count',v_count,'count',1,
        'items',jsonb_build_array(v_representative),
        'receipt_group_size',v_count,
        'receipt_group_skus',v_skus,
        'receipt_group_basis','same_yahoo_purchase_verified_source_and_allocation'
      );
    end if;
  end if;
  return v_probe || jsonb_build_object('items',v_items);
end
$function$;

notify pgrst,'reload schema';
