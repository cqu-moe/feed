#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACCOUNT_ID = "a666c560407022706a52a703923548d5";
export const WORKER_NAME = "cqu-e2e-20261016-feed";
export const D1_NAME = "cqu-e2e-20261016-feed-db";
export const R2_NAME = "cqu-e2e-20261016-feed-archive";
export const AUTH_SERVICE = "cqu-e2e-20261016-auth";
export const FEED_ORIGIN = "https://cqu-e2e-20261016-feed.user-unauthorized.workers.dev";
export const AUTH_ORIGIN = "https://cqu-e2e-20261016-auth.user-unauthorized.workers.dev";
export const PRODUCTION_D1_ID = "ba632f5c-c3b4-4f3c-ad57-1ac89895b02a";
export const TEST_FIXTURE_D1_ID = "11111111-2222-4333-8444-555555555555";

const queueNames = {
  jobs: "cqu-e2e-20261016-feed-jobs",
  jobsDlq: "cqu-e2e-20261016-feed-jobs-dlq",
  events: "cqu-e2e-20261016-feed-events",
  eventsDlq: "cqu-e2e-20261016-feed-events-dlq",
  mail: "cqu-e2e-20261016-feed-mail",
  mailDlq: "cqu-e2e-20261016-feed-mail-dlq",
};

const workflowNames = {
  ingest: "cqu-e2e-20261016-feed-ingest",
  pdfOcr: "cqu-e2e-20261016-feed-pdf-ocr",
  capture: "cqu-e2e-20261016-feed-capture",
  discovery: "cqu-e2e-20261016-feed-discovery",
  archiveOcr: "cqu-e2e-20261016-feed-archive-ocr",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildIsolatedConfig({ accountId, d1DatabaseId, feedOrigin, authOrigin }) {
  return {
    $schema: "../../../node_modules/wrangler/config-schema.json",
    name: WORKER_NAME,
    account_id: accountId,
    main: "../../../worker/index.mjs",
    compatibility_date: "2026-10-11",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    preview_urls: false,
    assets: {
      directory: "../../../dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    vars: {
      BASE_URL: feedOrigin,
      AUTH_BASE_URL: authOrigin,
      ENVIRONMENT: "preview",
      MAX_FIRECRAWL_PER_DAY: "1",
      MAX_OCR_PER_DAY: "1",
      MAX_ARTICLES_PER_RUN: "5",
      CRAWL_ENABLED: "false",
      TASK_RUNTIME_ENABLED: "false",
      MAIL_ENABLED: "false",
      MAX_MAIL_ATTEMPTS: "6",
      MAIL_PREPARE_LIMIT: "20",
      DIGEST_MAX_ITEMS: "20",
      DIGEST_MAX_BYTES: "65536",
      SOURCE_MANAGEMENT_ENABLED: "false",
      MAX_DISCOVERY_PAGES_PER_RUN: "2",
      DISCOVERY_ADMISSION_RETENTION_MS: "604800000",
      ARCHIVE_VERSIONS_ENABLED: "true",
      ARCHIVE_READS_ENABLED: "true",
      MAX_TASK_ATTEMPTS: "3",
      TASK_MAX_LAUNCH_ATTEMPTS: "5",
      TASK_LAUNCH_REPLAY_AFTER_MS: "900000",
      TASK_RETRY_BASE_DELAY_MS: "900000",
      TASK_RETRY_MAX_DELAY_MS: "21600000",
      QUEUE_DEAD_LETTER_AFTER_MS: "900000",
      OPERATIONS_DIAGNOSTIC_LIMIT: "20",
      PDF_OCR_ENABLED: "false",
      PDF_OCR_MODEL: "textin-xparse-auto",
      MAX_PDF_OCR_PAGES_PER_DAY: "1",
      MAX_PDF_OCR_PAGES_PER_MONTH: "1",
    },
    workflows: [
      { name: workflowNames.ingest, binding: "INGEST", class_name: "FeedIngest" },
      { name: workflowNames.pdfOcr, binding: "PDF_OCR", class_name: "PdfOcrWorkflow" },
      { name: workflowNames.capture, binding: "CAPTURE", class_name: "CaptureWorkflow" },
      { name: workflowNames.discovery, binding: "DISCOVERY", class_name: "DiscoveryWorkflow" },
      { name: workflowNames.archiveOcr, binding: "ARCHIVE_OCR", class_name: "ArchiveOcrWorkflow" },
    ],
    queues: {
      producers: [
        { binding: "FEED_JOBS", queue: queueNames.jobs },
        { binding: "FEED_EVENTS", queue: queueNames.events },
        { binding: "FEED_MAIL", queue: queueNames.mail },
      ],
      consumers: [
        {
          queue: queueNames.mail,
          dead_letter_queue: queueNames.mailDlq,
          max_batch_size: 5,
          max_batch_timeout: 5,
          max_retries: 5,
          retry_delay: 30,
        },
        {
          queue: queueNames.jobs,
          dead_letter_queue: queueNames.jobsDlq,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          retry_delay: 30,
        },
        {
          queue: queueNames.events,
          dead_letter_queue: queueNames.eventsDlq,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          retry_delay: 30,
        },
      ],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: D1_NAME,
        database_id: d1DatabaseId,
        migrations_dir: "../../../migrations",
      },
    ],
    r2_buckets: [{ binding: "ARCHIVE", bucket_name: R2_NAME }],
    services: [
      { binding: "AUTH", service: AUTH_SERVICE },
      { binding: "AUTH_FEED_RPC", service: AUTH_SERVICE, entrypoint: "AuthService" },
    ],
    limits: { cpu_ms: 30000 },
    observability: {
      enabled: true,
      head_sampling_rate: 0.1,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: true, head_sampling_rate: 0.1 },
    },
  };
}

function exactUrl(value, expected) {
  if (value !== expected) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function validateIsolation(config) {
  const errors = [];
  const fail = message => errors.push(message);
  const vars = config?.vars ?? {};

  if (config?.account_id !== ACCOUNT_ID) fail("account_id must be the dedicated E2E account");
  if (config?.name !== WORKER_NAME) fail("Worker name is not the dedicated FEED-05 name");
  if (config?.main !== "../../../worker/index.mjs") fail("main must resolve from generated/ to the unchanged Worker entrypoint");
  if (config?.assets?.directory !== "../../../dist") fail("assets.directory must resolve from generated/ to the unchanged build output");
  if (config?.d1_databases?.[0]?.migrations_dir !== "../../../migrations") {
    fail("migrations_dir must resolve from generated/ to the unchanged migration set");
  }
  if (config?.workers_dev !== true) fail("workers.dev must be enabled");
  if (config?.preview_urls !== false) fail("preview_urls must be disabled");
  if (config?.routes?.length) fail("routes and custom domains are forbidden");
  if ("route" in (config ?? {})) fail("route is forbidden");
  if (config?.triggers?.crons?.length) fail("cron triggers are forbidden");
  if (Object.keys(config?.triggers ?? {}).length) fail("only an absent triggers object is allowed");
  if ("ai" in (config ?? {})) fail("the production AI binding is forbidden");
  if (!exactUrl(vars.BASE_URL, FEED_ORIGIN)) fail("BASE_URL must be the exact isolated Feed origin");
  if (!exactUrl(vars.AUTH_BASE_URL, AUTH_ORIGIN)) fail("AUTH_BASE_URL must be the exact isolated Auth origin");
  if (config?.d1_databases?.length !== 1 || config.d1_databases[0]?.database_name !== D1_NAME) {
    fail("D1 binding must use only the dedicated database name");
  }
  const d1Id = config?.d1_databases?.[0]?.database_id;
  if (!UUID_PATTERN.test(d1Id ?? "")) fail("D1 database_id must be an actual UUID supplied by parent readback");
  if (d1Id === PRODUCTION_D1_ID) fail("production D1 ID is forbidden");
  if (d1Id === TEST_FIXTURE_D1_ID) fail("the known local dry-run fixture UUID must never be generated as deployment config");
  if (config?.r2_buckets?.length !== 1 || config.r2_buckets[0]?.bucket_name !== R2_NAME) {
    fail("R2 binding must use only the dedicated bucket");
  }

  const services = new Map((config?.services ?? []).map(service => [service.binding, service.service]));
  if (services.get("AUTH") !== AUTH_SERVICE || services.get("AUTH_FEED_RPC") !== AUTH_SERVICE) {
    fail("both Auth service bindings must target the isolated Auth Worker");
  }
  const rpc = (config?.services ?? []).find(service => service.binding === "AUTH_FEED_RPC");
  if (rpc?.entrypoint !== "AuthService") fail("AUTH_FEED_RPC must use the AuthService entrypoint");

  const actualQueues = new Set();
  for (const producer of config?.queues?.producers ?? []) actualQueues.add(producer.queue);
  for (const consumer of config?.queues?.consumers ?? []) {
    actualQueues.add(consumer.queue);
    if (!consumer.dead_letter_queue) fail("every consumer must declare a dedicated DLQ");
    actualQueues.add(consumer.dead_letter_queue);
  }
  const expectedQueues = new Set(Object.values(queueNames));
  if (actualQueues.size !== expectedQueues.size || [...expectedQueues].some(name => !actualQueues.has(name))) {
    fail("queue and DLQ names do not exactly match the dedicated FEED-05 set");
  }

  const actualWorkflows = new Set((config?.workflows ?? []).map(workflow => workflow.name));
  const expectedWorkflows = new Set(Object.values(workflowNames));
  if (actualWorkflows.size !== expectedWorkflows.size ||
      [...expectedWorkflows].some(name => !actualWorkflows.has(name))) {
    fail("workflow names do not exactly match the dedicated FEED-05 set");
  }

  for (const key of ["CRAWL_ENABLED", "TASK_RUNTIME_ENABLED", "MAIL_ENABLED", "PDF_OCR_ENABLED", "SOURCE_MANAGEMENT_ENABLED"]) {
    if (vars[key] !== "false") fail(`${key} must default to false`);
  }
  for (const key of ["ARCHIVE_VERSIONS_ENABLED", "ARCHIVE_READS_ENABLED"]) {
    if (vars[key] !== "true") fail(`${key} must remain enabled for ordinary reading paths`);
  }
  for (const key of [
    "MAX_FIRECRAWL_PER_DAY", "MAX_OCR_PER_DAY", "MAX_PDF_OCR_PAGES_PER_DAY", "MAX_PDF_OCR_PAGES_PER_MONTH",
  ]) {
    if (vars[key] === "0") fail(`${key} must not be "0"; this code treats zero as uncapped accounting`);
    if (!/^[1-9][0-9]*$/.test(vars[key] ?? "")) fail(`${key} must be a positive bounded integer`);
  }
  for (const key of ["POSTHOG_HOST", "POSTHOG_PROJECT_TOKEN", "MAIL_FROM", "RESEND_API_KEY", "FIRECRAWL_API_KEY", "TEXTIN_APP_ID", "TEXTIN_SECRET_CODE", "MISTRAL_API_KEY", "RESEND_WEBHOOK_SECRET", "BRIDGE_SECRET"]) {
    if (key in vars) fail(`${key} must not be placed in generated Wrangler vars`);
  }
  if (vars.ENVIRONMENT === "production") fail("ENVIRONMENT must not be production");

  const serialized = JSON.stringify(config ?? {});
  for (const forbidden of [
    PRODUCTION_D1_ID, "cqu-feed-mvp", "https://feed.cqu.moe", "https://auth.cqu.moe", "cqu-moe-auth", "https://p.cqu.moe",
  ]) {
    if (serialized.includes(forbidden)) fail(`production value ${forbidden} is forbidden`);
  }

  return errors;
}

export function buildDeploymentInput({ browserClientId, rpcClientId, d1DatabaseId }) {
  if (!browserClientId || !rpcClientId) throw new Error("Both actual OAuth browser and RPC client IDs are required");
  if (/^(placeholder|test|fake|<|>)/i.test(browserClientId) || /^(placeholder|test|fake|<|>)/i.test(rpcClientId)) {
    throw new Error("Client IDs must be actual Auth readback values, not placeholders");
  }
  return {
    source: {
      commit: "a7316fbb8d383a7e2853d9464170dda32b218c92",
      worker: WORKER_NAME,
      feedOrigin: FEED_ORIGIN,
      authOrigin: AUTH_ORIGIN,
      d1: { name: D1_NAME, id: d1DatabaseId },
    },
    authClientIds: { browser: browserClientId, rpc: rpcClientId },
    secretNames: [
      "FEED_AUTH_CLIENT_ID",
      "FEED_AUTH_CLIENT_SECRET",
      "FEED_SESSION_ENCRYPTION_KEY",
      "FEED_AUTH_RPC_CLIENT_ID",
      "FEED_AUTH_RPC_CLIENT_SECRET",
    ],
    optionalSecretNamesForApprovedPaths: ["ADMIN_TOKEN"],
    forbiddenSecretNamesByDefault: [
      "FIRECRAWL_API_KEY", "TEXTIN_APP_ID", "TEXTIN_SECRET_CODE", "MISTRAL_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "BRIDGE_SECRET",
    ],
    externalAccessDefault: {
      enabled: false,
      publicSourceOrigins: [
        "https://jwc.cqu.edu.cn", "https://intex.cqu.edu.cn", "https://civil.cqu.edu.cn",
        "https://xgb.cqu.edu.cn", "https://news.cqu.edu.cn",
      ],
      sourceReadProvider: "https://api.firecrawl.dev/v2/scrape",
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid arguments near ${key}`);
    const name = key.slice(2);
    if (!["account-id", "d1-database-id", "feed-origin", "auth-origin", "browser-client-id", "rpc-client-id"].includes(name)) {
      throw new Error(`Unknown argument --${name}`);
    }
    values[name] = argv[index + 1];
  }
  for (const name of ["account-id", "d1-database-id", "feed-origin", "auth-origin"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  if (Boolean(values["browser-client-id"]) !== Boolean(values["rpc-client-id"])) {
    throw new Error("Both client IDs must be supplied together, or both omitted");
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args["account-id"] !== ACCOUNT_ID) throw new Error("account-id is not the dedicated E2E account");
  if (args["feed-origin"] !== FEED_ORIGIN) throw new Error("feed-origin is not the expected dedicated workers.dev origin");
  if (args["auth-origin"] !== AUTH_ORIGIN) throw new Error("auth-origin is not the expected dedicated Auth origin");

  const config = buildIsolatedConfig({
    accountId: args["account-id"],
    d1DatabaseId: args["d1-database-id"],
    feedOrigin: args["feed-origin"],
    authOrigin: args["auth-origin"],
  });
  const errors = validateIsolation(config);
  if (errors.length) throw new Error(`Isolation validation failed:\n${errors.join("\n")}`);

  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(here, "generated/wrangler.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const outputs = [configPath];

  if (args["browser-client-id"]) {
    const manifest = buildDeploymentInput({
      browserClientId: args["browser-client-id"],
      rpcClientId: args["rpc-client-id"],
      d1DatabaseId: args["d1-database-id"],
    });
    const manifestPath = resolve(here, "generated/deployment-input.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    outputs.push(manifestPath);
  }
  console.log(outputs.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
