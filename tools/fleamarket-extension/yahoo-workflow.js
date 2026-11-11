export async function yahooReceiptContactFlow({itemId, contact, assertEligible, recoverReceived}) {
  await assertEligible();
  let result;
  try {
    result = await contact({itemId, action: 'receive'});
  } catch (error) {
    result = await recoverReceived(error);
  }
  if (result?.received !== true) throw Error('受け取り連絡後の完了を確認できません');
}
