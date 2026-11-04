import {cleanError} from './utils.mjs';

// Preserve the executor's structured result across Archive and Workflow receipts.
// Capacity means no source work began; source/network retries are real attempts.
export function captureFailure(error){
  const message=cleanError(error);
  const capacity=['container_capacity','capacity_busy'].includes(error?.code);
  const quota=error?.code==='quota_exhausted'||error?.httpStatus===402||/\b(?:budget|quota|credit)s?\b/i.test(message);
  const rate=error?.httpStatus===429||/\b429\b|rate limit/i.test(message);
  const code=capacity?'container_capacity':quota?'quota_exhausted':rate?'rate_limited':error?.code??'provider_error';
  const retryable=!quota&&error?.retryable===true;
  return {error:message,code,retryable,
    ...(capacity?{capacity:true}:{}),
    ...(capacity||quota||rate||retryable?{deferred:true}:{}),
    ...(Number.isFinite(error?.retryAfterMs)?{retryAfterMs:error.retryAfterMs}:{}),
  };
}
