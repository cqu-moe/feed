import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_ID,
  AUTH_ORIGIN,
  buildDeploymentInput,
  buildIsolatedConfig,
  FEED_ORIGIN,
  PRODUCTION_D1_ID,
  TEST_FIXTURE_D1_ID,
  validateIsolation,
} from "./generate-config.mjs";

const fixtureD1Id = TEST_FIXTURE_D1_ID;

function validInput(overrides = {}) {
  return {
    accountId: ACCOUNT_ID,
    d1DatabaseId: fixtureD1Id,
    feedOrigin: FEED_ORIGIN,
    authOrigin: AUTH_ORIGIN,
    ...overrides,
  };
}

test("builds and accepts the exact isolated topology", () => {
  const config = buildIsolatedConfig(validInput({ d1DatabaseId: randomUUID() }));
  assert.deepEqual(validateIsolation(config), []);
  assert.equal(config.name, "cqu-e2e-20261016-feed");
  assert.equal(config.queues.consumers.length, 3);
  assert.equal(config.workflows.length, 5);
  assert.equal(config.services.length, 2);
  assert.equal("ai" in config, false);
});

test("rejects wrong account and inherited production D1 identity", () => {
  assert.ok(validateIsolation(buildIsolatedConfig(validInput({ accountId: "another-account" }))).includes("account_id must be the dedicated E2E account"));
  assert.ok(validateIsolation(buildIsolatedConfig(validInput({ d1DatabaseId: PRODUCTION_D1_ID }))).includes("production D1 ID is forbidden"));
  const productionName = buildIsolatedConfig(validInput());
  productionName.d1_databases[0].database_name = "cqu-feed-mvp";
  assert.ok(validateIsolation(productionName).some(error => error.includes("dedicated database name")));
});

test("rejects production origins and service binding", () => {
  const productionFeed = buildIsolatedConfig(validInput({ feedOrigin: "https://feed.cqu.moe" }));
  productionFeed.vars.BASE_URL = "https://feed.cqu.moe";
  assert.ok(validateIsolation(productionFeed).some(error => error.includes("exact isolated Feed origin")));

  const productionAuth = buildIsolatedConfig(validInput({ authOrigin: "https://auth.cqu.moe" }));
  productionAuth.vars.AUTH_BASE_URL = "https://auth.cqu.moe";
  assert.ok(validateIsolation(productionAuth).some(error => error.includes("exact isolated Auth origin")));

  const config = buildIsolatedConfig(validInput());
  config.services[0].service = "cqu-moe-auth";
  assert.ok(validateIsolation(config).some(error => error.includes("isolated Auth Worker")));
});

test("rejects routes, cron, and AI inheritance", () => {
  const config = buildIsolatedConfig(validInput());
  config.routes = [{ pattern: "feed.cqu.moe", custom_domain: true }];
  config.triggers = { crons: ["*/5 * * * *"] };
  config.ai = { binding: "AI" };
  const errors = validateIsolation(config);
  assert.ok(errors.some(error => error.includes("routes and custom domains")));
  assert.ok(errors.some(error => error.includes("cron triggers")));
  assert.ok(errors.some(error => error.includes("AI binding")));
});

test("rejects unsafe vendor switches and zero-as-unlimited caps", () => {
  const config = buildIsolatedConfig(validInput());
  config.vars.CRAWL_ENABLED = "true";
  config.vars.MAX_PDF_OCR_PAGES_PER_MONTH = "0";
  const errors = validateIsolation(config);
  assert.ok(errors.includes("CRAWL_ENABLED must default to false"));
  assert.ok(errors.includes("MAX_PDF_OCR_PAGES_PER_MONTH must not be \"0\"; this code treats zero as uncapped accounting"));
});

test("rejects any missing or extra queue or workflow resource", () => {
  const config = buildIsolatedConfig(validInput());
  config.queues.producers[0].queue = "feed-jobs";
  assert.ok(validateIsolation(config).some(error => error.includes("queue and DLQ names")));

  const workflows = buildIsolatedConfig(validInput());
  workflows.workflows[0].name = "cqu-feed-ingest";
  assert.ok(validateIsolation(workflows).some(error => error.includes("workflow names")));
});

test("deployment input contains IDs but no secret values", () => {
  const input = buildDeploymentInput({
    browserClientId: "actual-browser-client-id",
    rpcClientId: "actual-rpc-client-id",
    d1DatabaseId: fixtureD1Id,
  });
  const serialized = JSON.stringify(input);
  assert.match(serialized, /actual-browser-client-id/);
  assert.match(serialized, /actual-rpc-client-id/);
  assert.doesNotMatch(serialized, /CLIENT_SECRET.*value/i);
  assert.ok(input.secretNames.includes("FEED_AUTH_CLIENT_SECRET"));
});

test("CLI rejects a nonactual placeholder and does not generate config", () => {
  const generator = fileURLToPath(new URL("./generate-config.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [generator, "--account-id", ACCOUNT_ID, "--d1-database-id", "placeholder", "--feed-origin", FEED_ORIGIN, "--auth-origin", AUTH_ORIGIN],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /D1 database_id must be an actual UUID/);
});

test("CLI rejects the known local schema-fixture UUID", () => {
  const generator = fileURLToPath(new URL("./generate-config.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [generator, "--account-id", ACCOUNT_ID, "--d1-database-id", TEST_FIXTURE_D1_ID, "--feed-origin", FEED_ORIGIN, "--auth-origin", AUTH_ORIGIN],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /known local dry-run fixture UUID/);
});
