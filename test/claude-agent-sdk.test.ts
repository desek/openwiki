/**
 * @agents-index Unit tests for the Claude Agent SDK LangChain adapter
 * (`ChatClaudeAgentSdkModel`), covering the message-and-tool-call bridge
 * (Risk 1) and the categorical auth/429 to guidance-error mapping (FR-8).
 *
 * The `@anthropic-ai/claude-agent-sdk` module is mocked so `query()` yields a
 * scripted message stream and captures the options the adapter passes it. This
 * exercises the translation layer without a live subscription or subprocess.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mutable state shared with the hoisted module mock: the scripted Agent SDK
 * message stream and the options captured from the last `query()` call.
 */
const state = vi.hoisted((): { messages: unknown[]; lastOptions: unknown } => ({
  messages: [],
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
      await Promise.resolve();
      for (const message of state.messages) {
        yield message;
      }
    })();
  },
}));

import { ChatClaudeAgentSdkModel } from "../src/agent/claude-agent-sdk.ts";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { z } from "zod";

const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
  state.messages = [];
  state.lastOptions = undefined;
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  }
});

describe("ChatClaudeAgentSdkModel bridging (Risk 1, NFR-1)", () => {
  test("bridges messages and tool calls", async () => {
    // Streamed text delta becomes assistant content; a namespaced tool_use
    // block becomes a de-namespaced LangChain tool_call.
    state.messages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "mcp__openwiki_tools__search",
              input: { q: "openwiki" },
            },
          ],
        },
      },
    ];

    const model = new ChatClaudeAgentSdkModel({ model: "claude-sonnet-5" });
    const bound = model.bindTools([
      {
        name: "search",
        description: "Search the wiki",
        schema: z.object({ q: z.string() }),
      },
    ]);

    const result = (await bound.invoke([
      new HumanMessage("find something"),
    ])) as AIMessage;

    expect(result.content).toContain("hello");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.name).toBe("search");
    expect(result.tool_calls?.[0]?.args).toEqual({ q: "openwiki" });
    expect(result.tool_calls?.[0]?.id).toBe("call-1");
  });

  test("maps auth 429 to guidance error", async () => {
    // A categorical assistant-message error surfaces as an FR-8 guidance error
    // naming the token, model, and subscription path.
    state.messages = [{ type: "assistant", error: "authentication_failed" }];

    const model = new ChatClaudeAgentSdkModel({ model: "claude-opus-4-8" });

    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow(
      /authentication_failed/u,
    );
    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/u,
    );
    await expect(model.invoke([new HumanMessage("hi")])).rejects.toThrow(
      /claude setup-token/u,
    );
  });
});
