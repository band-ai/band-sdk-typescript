import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../.github/scripts/opencode-zen-sign-in.sh", import.meta.url));
const OIDC_TOKEN = "github-oidc-jwt";
const ZEN_KEY = "zen-short-lived-key";
const SIGN_IN_FAILED = "OpenCode Zen sign-in failed: ";

/** A local stand-in for both GitHub's OIDC endpoint and the Zen token exchange. */
async function withEndpoints({ oidc, exchange, unset = [] }, run) {
  const oidcRequests = [];
  const exchanges = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const isOidc = request.url.startsWith("/oidc");
      const reply = isOidc ? oidc : exchange;
      if (isOidc) oidcRequests.push({ url: request.url, authorization: request.headers.authorization });
      else exchanges.push(Object.fromEntries(new URLSearchParams(body)));
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), "zen-sign-in-"));
  const githubEnv = join(dir, "github_env");
  await writeFile(githubEnv, "");
  try {
    const result = await new Promise((resolve) => {
      execFile(
        "bash",
        [SCRIPT],
        { env: env(base, githubEnv, unset) },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    await run({ ...result, githubEnv: await readFile(githubEnv, "utf8"), oidcRequests, exchanges });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** The runner environment the script expects, minus the `unset` names. */
function env(base, githubEnv, unset) {
  const vars = {
    PATH: process.env.PATH,
    OPENCODE_ZEN_CLIENT_ID: "client-1",
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?v=1`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    OPENCODE_ZEN_TOKEN_URL: `${base}/token`,
    GITHUB_ENV: githubEnv,
  };
  for (const name of unset) delete vars[name];
  return vars;
}

/** Asserts `text` contains each part, showing the whole text on failure. */
function assertIncludes(text, ...parts) {
  for (const part of parts) assert.ok(text.includes(part), `missing ${JSON.stringify(part)} in:\n${text}`);
}

const OIDC_OK = { status: 200, body: { value: OIDC_TOKEN } };
const UNREACHED = { status: 500, body: {} };

test("a granted exchange masks the key and exports it to later steps", async () => {
  await withEndpoints(
    { oidc: OIDC_OK, exchange: { status: 200, body: { access_token: ZEN_KEY, expires_in: 3600 } } },
    ({ code, stdout, githubEnv, oidcRequests, exchanges }) => {
      assert.equal(code, 0);
      assert.deepEqual(stdout.split("\n").filter(Boolean), [`::add-mask::${ZEN_KEY}`, "OpenCode Zen token expires_in=3600"]);
      assert.equal(githubEnv, `OPENCODE_ZEN_API_KEY=${ZEN_KEY}\n`);
      assert.deepEqual(oidcRequests, [
        { url: "/oidc?v=1&audience=https://opencode.ai/console", authorization: "Bearer request-token" },
      ]);
      assert.deepEqual(exchanges, [
        {
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          client_id: "client-1",
          subject_token: OIDC_TOKEN,
        },
      ]);
    },
  );
});

test("a rejected exchange logs the server's reason and exports nothing", async () => {
  const rejection = { error: "invalid_grant", error_description: "branch not trusted" };
  await withEndpoints({ oidc: OIDC_OK, exchange: { status: 400, body: rejection } }, ({ code, stderr, githubEnv }) => {
    assert.equal(code, 1);
    assertIncludes(stderr, `${SIGN_IN_FAILED}token exchange: `, "branch not trusted");
    assert.equal(githubEnv, "");
  });
});

test("an exchange that grants no key fails instead of exporting an empty one", async () => {
  await withEndpoints({ oidc: OIDC_OK, exchange: { status: 200, body: { expires_in: 3600 } } }, ({ code, stderr, githubEnv }) => {
    assert.equal(code, 1);
    assertIncludes(stderr, `${SIGN_IN_FAILED}token exchange returned no access_token (keys: ["expires_in"])`);
    assert.equal(githubEnv, "");
  });
});

test("an OIDC response without a token fails before the exchange is tried", async () => {
  await withEndpoints({ oidc: { status: 200, body: {} }, exchange: UNREACHED }, ({ code, stderr, githubEnv, exchanges }) => {
    assert.equal(code, 1);
    assertIncludes(stderr, `${SIGN_IN_FAILED}GitHub OIDC response has no token`);
    assert.deepEqual(exchanges, []);
    assert.equal(githubEnv, "");
  });
});

test("a refused OIDC request logs GitHub's reason and skips the exchange", async () => {
  const refusal = { message: "Unable to get ACTIONS_ID_TOKEN_REQUEST_URL" };
  await withEndpoints({ oidc: { status: 403, body: refusal }, exchange: UNREACHED }, ({ code, stderr, githubEnv, exchanges }) => {
    assert.equal(code, 1);
    assertIncludes(stderr, `${SIGN_IN_FAILED}GitHub OIDC request: `, refusal.message);
    assert.deepEqual(exchanges, []);
    assert.equal(githubEnv, "");
  });
});

test("a job without id-token: write fails before any request", async () => {
  await withEndpoints(
    { oidc: OIDC_OK, exchange: UNREACHED, unset: ["ACTIONS_ID_TOKEN_REQUEST_URL"] },
    ({ code, stderr, githubEnv, oidcRequests, exchanges }) => {
      assert.equal(code, 1);
      assertIncludes(stderr, "the job needs id-token: write");
      assert.deepEqual(oidcRequests, []);
      assert.deepEqual(exchanges, []);
      assert.equal(githubEnv, "");
    },
  );
});
