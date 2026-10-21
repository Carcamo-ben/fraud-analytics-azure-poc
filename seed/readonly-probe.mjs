export async function runReadonlyProbe(transaction, text) {
  let rolledBack = false;
  transaction.on('rollback', () => { rolledBack = true; });
  await transaction.begin();
  let denied = false;
  try {
    await transaction.request().query(text);
  } catch (error) {
    if ([229, 262, 2760, 15151, 15247].includes(error.number)) denied = true;
    else throw error;
  } finally {
    // SQL can automatically roll back a transaction when permission checks fail.
    if (!rolledBack) await transaction.rollback();
  }
  return denied;
}
