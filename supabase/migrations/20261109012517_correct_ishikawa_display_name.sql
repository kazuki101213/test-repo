update app.staff
set display_name = 'EE 石川 秀樹'
where code = 'EE'
  and name = '石川秀樹'
  and display_name is distinct from 'EE 石川 秀樹';
