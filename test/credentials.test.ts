import { afterEach, describe, expect, test } from "vitest";
import { needsCredentialSetup } from "../src/credentials.tsx";
import {
  getProviderApiKeyEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../src/constants.ts";

const ENV_KEYS = [
  "LANGSMITH_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_PROVIDER",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const originalValue = originalEnv.get(key);

    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("provider-list rendering surfaces anthropic-claude (FR-10, AC-10)", () => {
  test("the credentials provider list includes anthropic-claude and its four models", () => {
    // The onboarding/credentials UI renders from SELECTABLE_OPENWIKI_PROVIDERS
    // and getProviderModelOptions, so asserting these surfaces the new provider.
    expect(SELECTABLE_OPENWIKI_PROVIDERS).toContain("anthropic-claude");
    expect(getProviderLabel("anthropic-claude")).toBe(
      "Anthropic (Claude subscription)",
    );
    expect(
      getProviderModelOptions("anthropic-claude").map((m) => m.label),
    ).toEqual(["Sonnet", "Opus", "Haiku", "Fable"]);
  });

  test("its credential step collects the subscription OAuth token", () => {
    expect(getProviderApiKeyEnvKey("anthropic-claude")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
  });
});

describe("needsCredentialSetup", () => {
  test("requires provider setup for an invalid configured provider", () => {
    process.env.OPENWIKI_PROVIDER = "bogus";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-placeholder";
    process.env.OPENWIKI_MODEL_ID = "z-ai/glm-5.2";
    process.env.LANGSMITH_API_KEY = "lsv2_placeholder";

    expect(needsCredentialSetup()).toBe(true);
  });
});
