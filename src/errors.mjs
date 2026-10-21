export class AppError extends Error {
  constructor(status, code, message, { retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) {
      if (status !== 429 || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 86400) {
        throw new RangeError('Rate-limit retry timing must be an integer from 1 to 86400 seconds.');
      }
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export const invalid = (message) => new AppError(400, 'INVALID_REQUEST', message);
export const unavailable = (service) => new AppError(503, 'DEPENDENCY_UNAVAILABLE', `${service} is unavailable; no substitute results were generated.`);

export function safeError(error, traceId) {
  const known = error instanceof AppError;
  return {
    status: known ? error.status : 503,
    ...(known && error.status === 429 && Number.isSafeInteger(error.retryAfterSeconds) &&
      error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 86400 ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    body: { error: {
      code: known ? error.code : 'DEPENDENCY_UNAVAILABLE',
      message: known ? error.message : 'A required service is unavailable; no substitute results were generated.',
      traceId,
    } },
  };
}
