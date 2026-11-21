-- 経費名 ChatGPT を OPEN AI、Claude を ANTHROPIC にそろえる（2026-11-22 ユーザー指定）。
update app.expenses set name = 'OPEN AI' where name in ('CHATGPT', 'chatGPT($22)');
update app.expenses set name = 'ANTHROPIC' where name = 'claude($20)';
