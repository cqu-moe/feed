import { bounded } from './utils.mjs';

const FIRECRAWL_CREDITS_URL = 'https://api.firecrawl.dev/v2/team/credit-usage';
const TEXTIN_BALANCE_URL = 'https://api.textin.com/user/finance/balance';
const TEXTIN_PARSE_API_PATH = 'https://api.textin.com/api/v1/xparse/parse/sync';
const TEXTIN_PACKAGES_URL = `https://api.textin.com/user/finance/package?api_path=${encodeURIComponent(TEXTIN_PARSE_API_PATH)}&include_all=0`;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export async function readProviderUsage(env) {
  const [firecrawl, textin] = await Promise.all([
    readFirecrawl(env),
    readTextIn(env),
  ]);
  return { providers: { firecrawl, textin } };
}

async function readFirecrawl(env) {
  if (!env.FIRECRAWL_API_KEY) return unavailableProvider('not_configured');
  try {
    const payload = await getJson(FIRECRAWL_CREDITS_URL, {
      Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
    });
    if (payload?.success !== true || !isRecord(payload.data)) return unavailableProvider('invalid_response');

    const data = payload.data;
    const usage = {};
    const missingFields = [];
    copyNumber(usage, data, 'remainingCredits', missingFields);
    copyNumber(usage, data, 'planCredits', missingFields);
    copyString(usage, data, 'billingPeriodStart', missingFields);
    copyString(usage, data, 'billingPeriodEnd', missingFields);
    return {
      status: missingFields.length ? 'partial' : 'ok',
      usage: Object.keys(usage).length ? usage : null,
      missingFields,
    };
  } catch (error) {
    return {...unavailableProvider('unavailable'),error:failureDetails(error)};
  }
}

async function readTextIn(env) {
  if (!env.TEXTIN_APP_ID || !env.TEXTIN_SECRET_CODE)
    return { status: 'not_configured', balance: null, packages: null, missingFields: [], unavailableRequests: [] };
  const headers = {
    'x-ti-app-id': env.TEXTIN_APP_ID,
    'x-ti-secret-code': env.TEXTIN_SECRET_CODE,
  };
  const [balanceResult, packageResult] = await Promise.all([
    readTextInBalance(headers),
    readTextInPackages(headers),
  ]);
  const missingFields = [...balanceResult.missingFields, ...packageResult.missingFields];
  const unavailableRequests = [
    ...balanceResult.unavailable ? ['balance'] : [],
    ...packageResult.unavailable ? ['packages'] : [],
  ];
  return {
    status: unavailableRequests.length === 2 ? 'unavailable'
      : unavailableRequests.length || missingFields.length ? 'partial'
      : 'ok',
    balance: balanceResult.value,
    packages: packageResult.value,
    missingFields,
    unavailableRequests,
    ...(unavailableRequests.length?{errors:{
      ...(balanceResult.error?{balance:balanceResult.error}:{}),
      ...(packageResult.error?{packages:packageResult.error}:{}),
    }}:{}),
  };
}

async function readTextInBalance(headers) {
  try {
    const payload = await getJson(TEXTIN_BALANCE_URL, headers);
    if (payload?.code !== 200 || !isRecord(payload.data)) return textInResult(null, [], true,invalidProvider(payload));
    const data = payload.data;
    const value = {};
    const missingFields = [];
    copyNumber(value, data, 'balance', missingFields);
    copyNumber(value, data, 'available_balance', missingFields);
    copyNumber(value, data, 'unavailable_balance', missingFields);
    copyNumber(value, data, 'postpaid_amount', missingFields);
    copyNumber(value, data, 'unpaid', missingFields);
    copyNumber(value, data, 't_coin_give_total', missingFields);
    copyNumber(value, data, 't_coin_give_used', missingFields);
    if (data.pay_type === 1 || data.pay_type === 2) value.pay_type = data.pay_type;
    else missingFields.push('pay_type');
    return textInResult(Object.keys(value).length ? value : null, missingFields, false);
  } catch (error) {
    return textInResult(null, [], true,failureDetails(error));
  }
}

async function readTextInPackages(headers) {
  try {
    const payload = await getJson(TEXTIN_PACKAGES_URL, headers);
    if (payload?.code !== 200 || !isRecord(payload.data) || !Array.isArray(payload.data.list))
      return textInResult(null, [], true,invalidProvider(payload));

    const packages = [];
    const missingFields = [];
    payload.data.list.forEach((item, index) => {
      if (!isRecord(item)) {
        missingFields.push(`packages[${index}]`);
        return;
      }
      const normalized = {};
      copyCount(normalized, item, 'id', missingFields, 'id', `packages[${index}].id`);
      copyStringArray(normalized, item, 'service_list', missingFields, 'service_list', `packages[${index}].service_list`);
      copyString(normalized, item, 'start_time', missingFields, 'start_time', `packages[${index}].start_time`);
      copyString(normalized, item, 'end_time', missingFields, 'end_time', `packages[${index}].end_time`);
      copyCount(normalized, item, 'total_count', missingFields, 'total_count', `packages[${index}].total_count`);
      copyCount(normalized, item, 'remain_count', missingFields, 'remain_count', `packages[${index}].remain_count`, 'remaining_count');
      copyCount(normalized, item, 'use_count', missingFields, 'use_count', `packages[${index}].use_count`);
      packages.push(normalized);
    });
    return textInResult(packages, missingFields, false);
  } catch (error) {
    return textInResult(null, [], true,failureDetails(error));
  }
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new UsageReadError('http',response.status);
  const bytes = await bounded(response, MAX_RESPONSE_BYTES);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function copyNumber(target, source, field, missingFields, outputField = field, missingField = outputField) {
  if (Number.isFinite(source[field])) target[outputField] = source[field];
  else missingFields.push(missingField);
}

function copyString(target, source, field, missingFields, outputField = field, missingField = outputField) {
  if (typeof source[field] === 'string' && source[field].length <= 128) target[outputField] = source[field];
  else missingFields.push(missingField);
}

function copyStringArray(target, source, field, missingFields, outputField = field, missingField = outputField) {
  if (Array.isArray(source[field]) && source[field].every(item => typeof item === 'string') && source[field].length <= 100)
    target[outputField] = source[field];
  else missingFields.push(missingField);
}

function copyCount(target, source, field, missingFields, outputField = field, missingField = outputField, alias = field) {
  const value = source[field] ?? source[alias];
  if (Number.isSafeInteger(value) && value >= 0) target[outputField] = value;
  else missingFields.push(missingField);
}

function textInResult(value, missingFields, unavailable, error) {
  return { value, missingFields, unavailable, error };
}

function unavailableProvider(status) {
  return { status, usage: null, missingFields: [] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

class UsageReadError extends Error {
  constructor(kind,status){super('Provider usage unavailable');this.kind=kind;this.status=status;}
}
function failureDetails(error){
  if(error instanceof UsageReadError)return {kind:error.kind,status:error.status};
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return {kind:'timeout'};
  if(error instanceof SyntaxError)return {kind:'invalid_json'};
  if(error?.message==='Response too large')return {kind:'response_too_large'};
  return {kind:'network_or_decode'};
}
function invalidProvider(payload){
  return {kind:'provider_response',code:Number.isSafeInteger(payload?.code)?payload.code:null};
}
