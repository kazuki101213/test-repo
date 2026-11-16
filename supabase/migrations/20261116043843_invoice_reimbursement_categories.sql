alter table app.invoice_receipts
  drop constraint invoice_reimbursement_category,
  add constraint invoice_reimbursement_category
    check (category in (
      '配送費', '旅費交通費', '梱包資材費', '消耗品費', '支払手数料', '外注費', '研修費', '保管料', '固定費', '変動費'
    ));
