import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runReadonlyProbe } from '../seed/readonly-probe.mjs';

function transaction({ error, autoRollback = false, rollbackError } = {}) {
  const tx = new EventEmitter();
  tx.rollbacks = 0;
  tx.begin = async () => {};
  tx.request = () => ({
    query: async () => {
      if (autoRollback) tx.emit('rollback', true);
      if (error) throw error;
    },
  });
  tx.rollback = async () => {
    tx.rollbacks += 1;
    if (rollbackError) throw rollbackError;
    tx.emit('rollback', false);
  };
  return tx;
}

test('permission denial remains observable after SQL auto-rolls back', async () => {
  const tx = transaction({ error: { number: 229 }, autoRollback: true });
  assert.equal(await runReadonlyProbe(tx, 'denied probe'), true);
  assert.equal(tx.rollbacks, 0);
});

test('denied and unexpectedly successful probes are explicitly rolled back when active', async () => {
  for (const error of [{ number: 262 }, undefined]) {
    const tx = transaction({ error });
    assert.equal(await runReadonlyProbe(tx, 'bounded probe'), Boolean(error));
    assert.equal(tx.rollbacks, 1);
  }
});

test('unrelated SQL and rollback failures are not counted as permission denials', async () => {
  const error = Object.assign(new Error('Connection lost'), { number: 12345 });
  await assert.rejects(runReadonlyProbe(transaction({ error }), 'probe'), error);
  const rollbackError = new Error('Rollback failed');
  await assert.rejects(runReadonlyProbe(transaction({ rollbackError }), 'probe'), rollbackError);
});
