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

/** A local stand-in for both GitHub's OIDC endpoint and the Zen token exchange. */
async function withEndpoints({ oidc, exchange }, run) {
  const exchanges = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const reply = request.url.startsWith("/oidc") ? oidc : exchange;
      if (!request.url.startsWith("/oidc")) exchanges.push(new URLSearchParams(body));
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
        {
          env: {
            PATH: process.env.PATH,
            OPENCODE_ZEN_CLIENT_ID: "client-1",
            ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?v=1`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
            OPENCODE_ZEN_TOKEN_URL: `${base}/token`,
            GITHUB_ENV: githubEnv,
          },
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
    });
    await run({ ...result, githubEnv: await readFile(githubEnv, "utf8"), exchanges });
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const OIDC_OK = { status: 200, body: { value: OIDC_TOKEN } };

test("a granted exchange masks the key and exports it to later steps", async () => {
  await withEndpoints(
    { oidc: OIDC_OK, exchange: { status: 200, body: { access_token: ZEN_KEY, expires_in: 3600 } } },
    ({ code, stdout, githubEnv, exchanges }) => {
      assert.equal(code, 0);
      assert.deepEqual(stdout.split("\n").filter(Boolean), [`::add-mask::${ZEN_KEY}`, "OpenCode Zen token expires_in=3600"]);
      assert.equal(githubEnv, `OPENCODE_ZEN_API_KEY=${ZEN_KEY}\n`);
      assert.equal(exchanges.length, 1);
      assert.equal(exchanges[0].get("subject_token"), OIDC_TOKEN);
      assert.equal(exchanges[0].get("client_id"), "client-1");
    },
  );
});

test("a rejected exchange logs the server's reason and exports nothing", async () => {
  const rejection = { error: "invalid_grant", error_description: "branch not trusted" };
  await withEndpoints({ oidc: OIDC_OK, exchange: { status: 400, body: rejection } }, ({ code, stderr, githubEnv }) => {
    assert.notEqual(code, 0);
    assert.match(stderr, /OpenCode Zen sign-in failed: token exchange: .*branch not trusted/);
    assert.equal(githubEnv, "");
  });
});

test("an exchange that grants no key fails instead of exporting an empty one", async () => {
  await withEndpoints({ oidc: OIDC_OK, exchange: { status: 200, body: { expires_in: 3600 } } }, ({ code, stderr, githubEnv }) => {
    assert.notEqual(code, 0);
    assert.match(stderr, /token exchange returned no access_token/);
    assert.equal(githubEnv, "");
  });
});

test("an OIDC response without a token fails before the exchange is tried", async () => {
  await withEndpoints({ oidc: { status: 200, body: {} }, exchange: OIDC_OK }, ({ code, stderr, githubEnv, exchanges }) => {
    assert.notEqual(code, 0);
    assert.match(stderr, /GitHub OIDC response has no token/);
    assert.equal(exchanges.length, 0);
    assert.equal(githubEnv, "");
  });
});
