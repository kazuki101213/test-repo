begin;

-- 品番：新しい商品は同じメーカーの最後の品番の次に入り、後ろはずれる。
insert into app.products(asin, product_no, maker) values
  ('BMKRTEST01', 800001, 'Testmakera'),
  ('BMKRTEST02', 800002, 'Testmakerb'),
  ('BMKRTEST03', 800003, 'Testmakerc');
insert into app.marketplace_purchase_drafts(marketplace,marketplace_item_id,marketplace_url,account_label,title,product_id,product_no)
select 'メルカリ','maker-number-fixture','https://jp.mercari.com/item/maker-number-fixture','fixture','fixture',id,product_no
from app.products where asin = 'BMKRTEST02';

-- 全角スペース・大小文字・色の違いは同じメーカー。
insert into app.products(asin, maker) values ('BMKRTEST04', 'ＴＥＳＴＭＡＫＥＲＡ　白');
-- 1つの文で複数登録しても、それぞれのメーカーの下に入る。
insert into app.products(asin, maker) values ('BMKRTEST05', 'testmakerb'), ('BMKRTEST06', 'TestmakerA');
-- 空欄・初めてのメーカーは末尾。
insert into app.products(asin, maker) values ('BMKRTEST07', null), ('BMKRTEST08', 'Brandnewmaker');

do $test$
declare
  got text;
  top integer := (select max(product_no) from app.products);
begin
  select string_agg(asin || '=' || product_no, ',' order by product_no) into got
    from app.products where asin between 'BMKRTEST01' and 'BMKRTEST06';
  if got is distinct from 'BMKRTEST01=800001,BMKRTEST04=800002,BMKRTEST06=800003,BMKRTEST02=800004,BMKRTEST05=800005,BMKRTEST03=800006' then
    raise exception 'maker numbering wrong: %', got;
  end if;
  if (select product_no from app.products where asin = 'BMKRTEST08') <> top
     or (select product_no from app.products where asin = 'BMKRTEST07') <> top - 1 then
    raise exception 'unknown maker must be appended';
  end if;
  if (select product_no from app.marketplace_purchase_drafts where marketplace_item_id = 'maker-number-fixture') <> 800004 then
    raise exception 'purchase draft product_no must follow the product';
  end if;
end $test$;

rollback;
