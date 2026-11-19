-- LINE発送依頼の本文に入れる仕入れ先URLは、送信側（delivery-line）の許可リストに合うhttpsのURLだけにする。
-- marketplace_url にURL以外（Amazon返品の付属品メモ等）が入っていると、送信側で new URL() が失敗し
-- LINEを送らずに failed になっていた（1156b, 2026-11-20）。URLでなければ仕入れ先行を省いて送る。
do $migration$
declare
  source text := pg_get_functiondef('app.line_shipping_media(uuid)'::regprocedure);
  old_text text := $old$'supplierUrl',i.marketplace_url,$old$;
  new_text text := $new$'supplierUrl',case when i.marketplace_url ~ '^https://(auctions\.yahoo\.co\.jp|page\.auctions\.yahoo\.co\.jp|paypayfleamarket\.yahoo\.co\.jp|jp\.mercari\.com|item\.mercari\.com|fril\.jp|item\.fril\.jp|www\.amazon\.co\.jp|amazon\.co\.jp)(/[^[:space:]]*)?$' then i.marketplace_url end,$new$;
begin
  if strpos(source, old_text) = 0 then
    raise exception 'Expected supplierUrl expression not found';
  end if;
  execute replace(source, old_text, new_text);
end;
$migration$;
