grant select on app.items, app.staff, app.profiles to service_role;
grant update (sold_on,sold_price,payout_amount) on app.items to service_role;
