import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, toolCallArguments } from "../tool-arguments";

const parse = (s: string | null) => (s ? JSON.parse(s) : null);

test("Bash keeps the command and description", () => {
  assert.deepEqual(parse(toolCallArguments("Bash", { command: "npm test -- --run", description: "Run unit tests" })), {
    command: "npm test -- --run",
    description: "Run unit tests",
  });
});

test("file tools keep the path, never the content or edit strings", () => {
  assert.deepEqual(parse(toolCallArguments("Write", { file_path: "/w/a.ts", content: "SECRET" })), { file_path: "/w/a.ts" });
  assert.deepEqual(parse(toolCallArguments("Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" })), { file_path: "/w/a.ts" });
  assert.deepEqual(parse(toolCallArguments("write_file", { path: "a.ts", content: "x" })), { path: "a.ts" });
  assert.equal(toolCallArguments("TodoWrite", { todos: [{ content: "x" }] }), null);
});

test("unknown (MCP) tools keep short scalars but drop content and secret-named fields", () => {
  const args = parse(toolCallArguments("mcp__github__create_issue", {
    repo: "acme/web",
    title: "Fix login",
    body: "long text",
    api_token: "abc",
    labels: ["bug"],
    count: 3,
  }));
  assert.deepEqual(args, { repo: "acme/web", title: "Fix login", count: 3 });
});

test("bad input records nothing", () => {
  assert.equal(toolCallArguments("Bash", undefined), null);
  assert.equal(toolCallArguments("Bash", "ls"), null);
  assert.equal(toolCallArguments("Bash", {}), null);
});

test("long values are clipped", () => {
  const args = parse(toolCallArguments("Bash", { command: "x".repeat(5000) }));
  assert.equal(args.command.length, 1000);
  assert.ok(args.command.endsWith("…"));
});

test("secrets are masked", () => {
  const cases: Array<[string, string]> = [
    [`curl -H "Authorization: Bearer abc.def.ghi123" https://api.x`, "abc.def.ghi123"],
    ["curl -u x https://api.x -H 'Authorization: token ghp_abcdefghijklmnop1234'", "ghp_abcdefghijklmnop1234"],
    ["export GITHUB_TOKEN=ghx123456789 && gh pr list", "ghx123456789"],
    ["DATABASE_PASSWORD='hunter2' npm run migrate", "hunter2"],
    ["psql postgres://admin:s3cret@db:5432/app", "s3cret"],
    ["curl 'https://x.io/cb?code=1&access_token=zzz999'", "zzz999"],
    ["mytool --api-key 0123abcd --verbose", "0123abcd"],
    ["mytool --password=pa55", "pa55"],
    ["echo sk-ant-api03-abcdefghijklmnop", "sk-ant-api03-abcdefghijklmnop"],
    ["echo tm_live_abcdefghijklmn", "tm_live_abcdefghijklmn"],
    ["aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_part-1", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"],
    ["printf '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'", "MIIEow"],
  ];
  for (const [command, secret] of cases) {
    const out = redactSecrets(command);
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
    assert.ok(out.includes("***"), out);
  }
});

test("ordinary commands are left alone", () => {
  for (const c of ["git status", "npm run lint && npm test", "ls -la src/lib", "rg 'useState' src --type ts", "cd /workspaces/abc/web && npx tsc --noEmit"]) {
    assert.equal(redactSecrets(c), c);
  }
});
