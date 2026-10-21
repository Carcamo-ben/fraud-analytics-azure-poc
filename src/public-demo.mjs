import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.mjs';
import { GUID } from './validation.mjs';

export function publicDemoUser(config) {
  if (!config.publicDemo || config.role !== 'web' || !GUID.test(config.demoUserOid ?? '') ||
      !config.allowedUsers.has(config.demoUserOid) || config.policyOwnerOids.has(config.demoUserOid)) {
    throw new AppError(503, 'DEMO_CONFIGURATION', 'The public synthetic demo is not configured safely.');
  }
  return Object.freeze({
    oid: config.demoUserOid, displayName: 'Public synthetic demo',
    businessUnit: 'poc', roles: Object.freeze(['analyst']),
  });
}

export function createDemoBudget({ filePath, dailyLimit = 300, clock = () => new Date() }) {
  let pending = Promise.resolve();
  return () => {
    const result = pending.then(async () => {
      const now = clock();
      const day = now.toISOString().slice(0, 10);
      let state;
      try {
        state = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { day, used: 0 };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !Number.isSafeInteger(state.used) || state.used < 0) {
        throw new AppError(503, 'DEMO_BUDGET_UNAVAILABLE', 'The shared demo request budget is unavailable.');
      }
      if (state.day > day) throw new AppError(503, 'DEMO_BUDGET_UNAVAILABLE', 'The demo clock is inconsistent with its request budget.');
      if (state.day !== day) state = { day, used: 0 };
      if (state.used >= dailyLimit) {
        throw new AppError(429, 'DEMO_DAILY_LIMIT', 'The shared synthetic demo has reached its daily request limit. Try again after midnight UTC.',
          { retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now.getTime()) / 1000)) });
      }
      state.used += 1;
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.pending`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, filePath);
    });
    pending = result.catch(() => {});
    return result;
  };
}
