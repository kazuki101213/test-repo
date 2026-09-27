-- Account linking is an operator-only action; normal login does not use this function.
revoke execute on function app.link_login(text, text) from public, anon, authenticated;
grant execute on function app.link_login(text, text) to service_role;
