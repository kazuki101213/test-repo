-- Text-only templates use the same return authorization as a manual reply.
create or replace function app.is_supplier_return_instruction(p_body text)
returns boolean
language sql immutable strict
set search_path = ''
as $$
  select body ~ '(?n)^[[:blank:]]*(返品くんで[[:blank:]]*返品|(返送|返品))(を)?[[:blank:]]*(お願いします|お願いいたします|してください)[。！!]?[[:blank:]]*$'
    or body ~ E'(?n)^【[^】\\n]+】【[^】\\n]+】【[^】\\n]+】[[:blank:]]*\\n[[:blank:]]*着払いでお願いします。[[:blank:]]*$'
  from (select replace(p_body, chr(13), '') as body) normalized;
$$;
