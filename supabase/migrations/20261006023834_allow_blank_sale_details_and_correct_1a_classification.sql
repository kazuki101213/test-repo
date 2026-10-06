alter table app.items drop constraint if exists items_sold_requires_date;
alter table app.items disable trigger items_single_product_sale;
alter table app.items disable trigger items_sync_accessory_sale_date;
do $$
declare updated_count integer;
begin
  update app.items i
     set is_accessory = false, sold_on = v.sold_on, sold_price = v.sold_price, payout_amount = v.payout_amount
    from (values
    ('c5577d24-a126-4709-a552-2b792a19b917'::uuid,'2025-02-08'::date,21980,19327),
    ('d9cb0610-144b-4b89-9f2d-65ae224e8a1e'::uuid,'2025-04-27'::date,6680,4962),
    ('8d006fc1-42d0-4f81-92ba-66a574ee06d9'::uuid,'2025-03-27'::date,18900,17237),
    ('c0d0e4f9-9578-4ef2-a4f5-ddc3c81e336d'::uuid,'2025-02-10'::date,7000,5765),
    ('b865fcb6-ff0c-49b2-9292-de27ce98c1ec'::uuid,'2025-02-13'::date,15500,13361),
    ('035e4477-e96e-46d7-a2e5-9baaa0d2804c'::uuid,'2025-04-03'::date,6980,6212),
    ('853c9059-e98c-4b7b-9467-0fbf0ce58e17'::uuid,'2025-02-09'::date,16980,14092),
    ('732aca09-7014-41c6-b09c-43db77f0d15d'::uuid,'2025-02-16'::date,14500,12420),
    ('c20a6529-3d6e-461a-8705-c0e337f6011b'::uuid,null,null,null),
    ('bd96ec21-5417-4698-bd98-7174fdf18de7'::uuid,'2025-03-04'::date,6980,5397),
    ('f3e7f454-d722-44b5-a8d9-7f19a7bb6b49'::uuid,'2025-02-06'::date,29907,23296),
    ('09c62409-2ecb-4dd8-9918-bcbc01701e99'::uuid,'2025-02-26'::date,25480,22804),
    ('ce258441-9437-4e9f-aa41-5d3d41237bcc'::uuid,null,null,null),
    ('f163f54f-286c-47f1-9c2b-600cd173f32c'::uuid,null,null,null),
    ('d6a9ed9a-2c53-4fb8-ad24-0b71286a22ca'::uuid,null,null,null),
    ('3b382920-539b-41e4-b09f-be1a31eec507'::uuid,'2025-03-22'::date,3500,2300),
    ('af669ec6-9628-4d4c-9a92-bc081741d9cc'::uuid,'2025-02-25'::date,16398,13247),
    ('4a674b64-d915-4dd5-be11-02955f835bf8'::uuid,'2025-02-24'::date,26800,23338),
    ('83a2476d-d15b-47c3-8890-86fc3513b1c0'::uuid,'2025-03-01'::date,7970,6803),
    ('0c83b13b-d98f-472c-ba26-efd89ff44dbd'::uuid,'2025-02-15'::date,21980,19048),
    ('b5221101-efbc-4331-a884-7d6d4f78308a'::uuid,'2025-04-04'::date,19480,17337),
    ('06c89878-1e9e-439e-81ee-36c41228bd2d'::uuid,'2025-02-15'::date,9980,8287),
    ('54edb64b-437c-4a2d-a15f-a8655f582107'::uuid,'2025-03-01'::date,16980,14092),
    ('10c7b8e4-f96b-4d58-9d02-1554ae6f65cd'::uuid,'2025-03-01'::date,16500,13665),
    ('b3f9f492-6ca3-4e0a-85de-b5108a5b793f'::uuid,'2025-03-06'::date,22470,19513),
    ('2553c429-49fa-4af8-87a0-b5f2723ad9ad'::uuid,'2025-03-01'::date,22480,19522),
    ('5bb3f471-18a4-4a0b-a2f6-b5cc54b2e804'::uuid,'2025-02-27'::date,16000,13945),
    ('56267ca2-c3e2-4b41-8274-b56c4b9ce3f2'::uuid,'2025-03-08'::date,24380,21213),
    ('74d2649f-9e23-43e3-a0ed-ed7a1f7a593f'::uuid,'2025-03-01'::date,24000,20875),
    ('4a4a6d8c-5316-478f-b254-62e302ce8e82'::uuid,'2025-03-24'::date,22980,19967),
    ('16af97e2-b07b-4497-8560-b2981390f601'::uuid,'2025-03-31'::date,20980,18187),
    ('ff825f70-202a-4bcb-b7b4-d06cea477c00'::uuid,'2025-03-19'::date,11980,9489),
    ('7dd45a49-f225-4ea4-89ef-cf505a017798'::uuid,'2025-03-16'::date,15127,12949),
    ('949dc228-0e7d-4849-932c-142585813c93'::uuid,'2025-03-17'::date,19900,17306),
    ('b80676ba-c953-4fba-9f7d-e0bea577f822'::uuid,null,null,null),
    ('6d789bdb-7f78-4345-847b-bf3189368a71'::uuid,'2025-03-16'::date,23480,20412),
    ('f353973b-edbd-4ee1-b24f-e7ab29aa4fd9'::uuid,null,null,null),
    ('6676ddd7-1a42-491d-84f6-07f0c83b7f34'::uuid,'2025-03-22'::date,4300,3415),
    ('84c3f7c9-ab33-4594-9350-0d84aeec7c1e'::uuid,'2025-03-22'::date,7044,5609),
    ('90fe60aa-ab0e-4184-a58d-de54d6c41567'::uuid,'2025-04-17'::date,13980,12075),
    ('c27d093b-891b-45d6-8de7-3cc42450a1a3'::uuid,null,null,null),
    ('164384bf-8d00-4a9a-a34f-7b590b57b325'::uuid,'2025-03-14'::date,18800,16331),
    ('df4bce2d-3401-4cd0-807e-81b3d0bba258'::uuid,'2025-03-09'::date,9280,7950),
    ('d81a06c8-bb8d-43c4-a156-60b1cc01027a'::uuid,'2025-03-04'::date,18800,17146),
    ('b381aed0-168d-4761-9b42-54f7341634af'::uuid,'2025-03-03'::date,18255,15328),
    ('362306c0-bdd0-4e2d-a30a-7a92d8830939'::uuid,'2025-03-10'::date,20780,18240),
    ('e684fedb-fa16-4b45-a347-9a52a7497e80'::uuid,'2025-04-03'::date,14980,12818)
    ) as v(id, sold_on, sold_price, payout_amount)
   where i.id = v.id and i.sku like '1a-%' and i.is_accessory = true;
  get diagnostics updated_count = row_count;
  if updated_count <> 47 then raise exception 'Expected 47 matched 1a rows; updated %', updated_count; end if;
end;
$$;
alter table app.items enable trigger items_single_product_sale;
alter table app.items enable trigger items_sync_accessory_sale_date;
