const ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "INVALID_CLIENT",
  "CLIENT_NOT_ALLOWED",
  "SUBJECT_UNAVAILABLE",
  "AUTH_UNAVAILABLE",
  "AUTH_DATA_INVALID",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSubscriptionLimit(value) {
  if (!isRecord(value)) return null;
  if (value.kind === "unlimited" || value.kind === "missing") {
    return { kind: value.kind };
  }
  if (
    value.kind === "limited" &&
    typeof value.value === "number" &&
    Number.isSafeInteger(value.value) &&
    value.value >= 0
  ) {
    return { kind: "limited", value: value.value };
  }
  return null;
}

function parsePolicy(value) {
  if (!isRecord(value) || typeof value.access !== "boolean") return null;
  const subscriptionLimit = parseSubscriptionLimit(value.subscriptionLimit);
  return subscriptionLimit && { access: value.access, subscriptionLimit };
}

function parseRecipient(value) {
  if (!isRecord(value)) return null;
  if (value.status === "unverified" || value.status === "blocked") {
    return { status: value.status };
  }
  if (value.status === "verified" && typeof value.email === "string" && value.email) {
    return { status: "verified", email: value.email };
  }
  return null;
}

function validateEnvelope(value, parseData) {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    if (
      typeof value.code !== "string" ||
      !ERROR_CODES.has(value.code) ||
      typeof value.retryable !== "boolean" ||
      typeof value.requestId !== "string"
    ) return null;
    return {
      ok: false,
      code: value.code,
      retryable: value.retryable,
      requestId: value.requestId,
    };
  }
  if (
    value.contractVersion !== 1 ||
    typeof value.checkedAt !== "number" ||
    !Number.isFinite(value.checkedAt)
  ) return null;
  const data = parseData(value.data);
  return data && {
    ok: true,
    contractVersion: 1,
    checkedAt: value.checkedAt,
    data,
  };
}

function transportFailure() {
  return {
    ok: false,
    code: "AUTH_UNAVAILABLE",
    retryable: true,
    requestId: crypto.randomUUID(),
  };
}

function adapterConfigurationFailure() {
  return {
    ok: false,
    code: "CLIENT_NOT_ALLOWED",
    retryable: false,
    requestId: crypto.randomUUID(),
  };
}

function invalidResponseFailure() {
  return {
    ok: false,
    code: "AUTH_DATA_INVALID",
    retryable: false,
    requestId: crypto.randomUUID(),
  };
}

async function invoke(env, method, userId) {
  const binding = env.AUTH_FEED_RPC;
  const clientId = env.FEED_AUTH_RPC_CLIENT_ID;
  const clientSecret = env.FEED_AUTH_RPC_CLIENT_SECRET;
  if (
    typeof binding?.[method] !== "function" ||
    typeof clientId !== "string" ||
    !clientId ||
    typeof clientSecret !== "string" ||
    !clientSecret
  ) return adapterConfigurationFailure();

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("feed_auth_rpc_timeout")), 10_000);
  });
  try {
    const response = await Promise.race([
      binding[method]({
        contractVersion: 1,
        clientId,
        clientSecret,
        userId,
      }),
      timeout,
    ]);
    return response;
  } catch {
    return transportFailure();
  } finally {
    clearTimeout(timer);
  }
}

export function createFeedAuthClient(env) {
  return {
    async getPolicy(userId) {
      const response = await invoke(env, "getFeedPolicy", userId);
      return validateEnvelope(response, parsePolicy) ?? invalidResponseFailure();
    },
    async getRecipient(userId) {
      const response = await invoke(env, "getFeedRecipient", userId);
      return validateEnvelope(response, (value) => {
        if (!isRecord(value)) return null;
        const policy = parsePolicy(value.policy);
        const recipient = parseRecipient(value.recipient);
        return policy && recipient && { policy, recipient };
      }) ?? invalidResponseFailure();
    },
  };
}

export async function feedAccountStatus(env, userId) {
  const response = await createFeedAuthClient(env).getRecipient(userId);
  if (!response.ok) {
    return {
      status: response.retryable ? "auth_unavailable" : "unavailable",
      reason: response.code,
    };
  }
  const recipient = response.data.recipient;
  return {
    status: "available",
    access: response.data.policy.access,
    subscriptionLimit: response.data.policy.subscriptionLimit,
    email: !response.data.policy.access
      ? { status: "blocked" }
      : recipient.status === "verified"
      ? { status: "verified", address: recipient.email }
      : { status: recipient.status },
  };
}
