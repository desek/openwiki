/**
 * @agents-index Unit tests for wiring the anthropic-claude provider into
 * `createModel` and the auth guards: the provider yields the Agent SDK adapter
 * (FR-2/AC-2), a missing token fails fast with an actionable error (FR-7/AC-7),
 * and the ANTHROPIC_API_KEY footgun is neutralized in the SDK env with a warning
 * (FR-6/AC-6, Risk 2).
 *
 * The `@anthropic-ai/claude-agent-sdk` module is mocked so `query()` captures
 * the options the adapter passes it (to assert the scrubbed env) without a live
 * subscription or subprocess.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** Captures the options handed to the mocked Agent SDK `query()`. */
const state = vi.hoisted((): { lastOptions: unknown } => ({
  lastOptions: undefined,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  AbortError: class AbortError extends Error {},
  createSdkMcpServer: (config: unknown) => config,
  tool: (
    name: string,
    description: string,
    shape: unknown,
    handler: unknown,
  ) => ({ name, description, shape, handler }),
  query: ({ options }: { prompt: string; options: unknown }) => {
    state.lastOptions = options;
    return (async function* () {
      // Empty stream: the adapter returns an empty generation, which is enough
      // to assert the query options (scrubbed env) the adapter constructed.
      await Promise.resolve();
      yield* [];
    })();
  },
}));

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import {
  createModel,
  warnOnAnthropicApiKeyFootgun,
} from "../src/agent/index.ts";
import { ChatClaudeAgentSdkModel } from "../src/agent/claude-agent-sdk.ts";

const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  state.lastOptions = undefined;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  }
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

describe("createModel for anthropic-claude (FR-2, AC-2)", () => {
  test("createModel returns SDK adapter, not ChatAnthropic", () => {
    const model = createModel("anthropic-claude", "claude-sonnet-5", 0);

    expect(model).toBeInstanceOf(ChatClaudeAgentSdkModel);
    expect(model).not.toBeInstanceOf(ChatAnthropic);
  });
});

describe("missing token guard (FR-7, AC-7)", () => {
  test("missing token throws actionable error", async () => {
    const model = createModel("anthropic-claude", "claude-sonnet-5", 0);

    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/u,
    );
    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow(
      /claude setup-token/u,
    );
  });
});

describe("ANTHROPIC_API_KEY footgun (FR-6, AC-6, Risk 2)", () => {
  test("scrubs ANTHROPIC_API_KEY from the SDK env", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    process.env.ANTHROPIC_API_KEY = "metered-key";

    const model = createModel("anthropic-claude", "claude-sonnet-5", 0);
    await model.invoke([new HumanMessage("hi")]);

    const env = (
      state.lastOptions as { env: Record<string, string | undefined> }
    ).env;
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
  });

  test("emits a warning when ANTHROPIC_API_KEY is also present", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    process.env.ANTHROPIC_API_KEY = "metered-key";

    const events: Array<{ type: string; text?: string }> = [];
    warnOnAnthropicApiKeyFootgun("anthropic-claude", {
      onEvent: (event: { type: string; text?: string }) => events.push(event),
    });

    const warning = events.find((event) => event.type === "text");
    expect(warning?.text).toContain("ANTHROPIC_API_KEY");
    expect(warning?.text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("does not warn when only the token is present", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";

    const events: unknown[] = [];
    warnOnAnthropicApiKeyFootgun("anthropic-claude", {
      onEvent: (event) => events.push(event),
    });

    expect(events).toHaveLength(0);
  });
});
