alter type app.item_status rename value '作業中' to '受取前';
alter type app.item_status add value if not exists '検品中' before '出品中';
alter type app.item_status add value if not exists 'Amazon返送依頼' before '出品中';
alter type app.item_status add value if not exists 'Amazon補填申請中' before '出品中';
alter type app.item_status add value if not exists '商品登録前' before '出品中';
alter type app.item_status add value if not exists '取引中' after '出品中';
alter type app.item_status add value if not exists '動作不良' after '返品処理';
