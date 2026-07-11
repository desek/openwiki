import { afterEach, describe, expect, test } from "vitest";
import {
  formatEnv,
  getCredentialDiagnostics,
  MANAGED_ENV_KEYS,
  parseEnv,
} from "../src/env.ts";
import { CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY } from "../src/constants.ts";

describe("parseEnv", () => {
  test("parses simple KEY=value lines", () => {
    expect(parseEnv("OPENWIKI_PROVIDER=anthropic\n")).toEqual({
      OPENWIKI_PROVIDER: "anthropic",
    });
  });

  test("skips blank lines and comments", () => {
    const content = ["# a comment", "", "OPENAI_API_KEY=abc", "   "].join("\n");

    expect(parseEnv(content)).toEqual({ OPENAI_API_KEY: "abc" });
  });

  test("ignores lines with no '=' or an empty key", () => {
    expect(parseEnv("noequalshere\n=value\n")).toEqual({});
  });

  test("rejects keys that are not UPPER_SNAKE_CASE", () => {
    expect(parseEnv("lowercase=x\nMixed_Case=y\nOK_KEY=z\n")).toEqual({
      OK_KEY: "z",
    });
  });

  test("unquotes and unescapes double-quoted values", () => {
    expect(parseEnv('ANTHROPIC_BASE_URL="https://a.example/v1"\n')).toEqual({
      ANTHROPIC_BASE_URL: "https://a.example/v1",
    });
    expect(parseEnv('OPENAI_API_KEY="line1\\nline2"\n')).toEqual({
      OPENAI_API_KEY: "line1\nline2",
    });
    expect(parseEnv('OPENAI_API_KEY="a\\"b\\\\c"\n')).toEqual({
      OPENAI_API_KEY: 'a"b\\c',
    });
  });

  test("leaves unquoted values as-is", () => {
    expect(parseEnv("OPENWIKI_MODEL_ID=gpt-5.5\n")).toEqual({
      OPENWIKI_MODEL_ID: "gpt-5.5",
    });
  });
});

describe("formatEnv", () => {
  test("quotes and escapes values, terminating with a newline", () => {
    expect(formatEnv({ OPENAI_API_KEY: "abc" })).toBe('OPENAI_API_KEY="abc"\n');
    expect(formatEnv({ OPENAI_API_KEY: 'a"b\\c\nd' })).toBe(
      'OPENAI_API_KEY="a\\"b\\\\c\\nd"\n',
    );
  });

  test("orders managed keys first, then unknown keys sorted alphabetically", () => {
    const formatted = formatEnv({
      ZZZ_CUSTOM: "z",
      AAA_CUSTOM: "a",
      OPENWIKI_PROVIDER_RETRY_ATTEMPTS: "3",
      OPENWIKI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k",
    });
    const keys = formatted
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")));

    // Managed keys keep their MANAGED_ENV_KEYS relative order (ANTHROPIC before
    // PROVIDER), and the two unknown keys follow, sorted.
    expect(keys).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENWIKI_PROVIDER",
      "OPENWIKI_PROVIDER_RETRY_ATTEMPTS",
      "AAA_CUSTOM",
      "ZZZ_CUSTOM",
    ]);
  });
});

describe("CLAUDE_CODE_OAUTH_TOKEN managed secret (FR-9, NFR-2)", () => {
  const original = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY];
    } else {
      process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY] = original;
    }
  });

  test("token is a managed key placed after the Anthropic keys", () => {
    // Modify: managed-keys order now includes the subscription OAuth token,
    // grouped with the other Anthropic credentials.
    expect(MANAGED_ENV_KEYS).toContain(CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY);
    const keys = MANAGED_ENV_KEYS as readonly string[];
    expect(keys.indexOf(CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY)).toBe(
      keys.indexOf("ANTHROPIC_BASE_URL") + 1,
    );
  });

  test("token is a managed masked secret in diagnostics", async () => {
    const secret = "oauth-super-secret-token-value-1234567890";
    process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY] = secret;

    const diagnostics = await getCredentialDiagnostics();
    const entry = diagnostics.find(
      (d) => d.key === CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY,
    );

    expect(entry).toBeDefined();
    expect(entry?.length).toBe(secret.length);
    // Preview is a masked first6...last4 form, never the plaintext token.
    expect(entry?.preview).not.toContain(secret);
    expect(entry?.preview).toContain("...");
  });
});

describe("parseEnv <-> formatEnv round-trip", () => {
  test("values survive a format -> parse round-trip", () => {
    const original = {
      OPENAI_API_KEY: 'weird "value" with\nnewline and \\ backslash',
      ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
      OPENWIKI_MODEL_ID: "claude-opus-4-8",
    };

    expect(parseEnv(formatEnv(original))).toEqual(original);
  });
});
