/**
 * @agents-index LangChain BaseChatModel adapter that routes inference through
 * the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) so a Claude
 * subscription OAuth token unlocks the full model lineup.
 *
 * This module isolates the Agent SDK behind the existing `createModel` seam in
 * `src/agent/index.ts`. DeepAgents consumes a LangChain chat model; the raw
 * Messages API (`ChatAnthropic`) caps subscription tokens to Haiku, whereas the
 * Agent SDK runtime emits the OAuth-sanctioned headers and therefore reaches
 * Sonnet, Opus, Haiku, and Fable. The adapter maps inbound LangChain messages
 * (and DeepAgents' bound tool schemas) to a single Agent SDK inference turn
 * with the SDK's own agent loop and filesystem tools disabled, then translates
 * the streamed assistant output (text and `tool_use` blocks) back into
 * LangChain `AIMessageChunk`s carrying `tool_calls`, preserving DeepAgents' own
 * tool-calling loop.
 *
 * Design constraints (why, not what):
 * - The SDK is used strictly for authenticated model inference, never for its
 *   own agentic loop: `tools: []`, `settingSources: []`, `maxTurns: 1`, and a
 *   `canUseTool` that denies-and-interrupts keep the SDK from executing tools
 *   so the caller (DeepAgents) owns the tool-calling loop.
 * - `ANTHROPIC_API_KEY` is scrubbed from the SDK subprocess environment (FR-6):
 *   the SDK REPLACES (does not merge) the subprocess env when `env` is set, so
 *   we spread `process.env` minus the key to keep `PATH`/`HOME` while forcing
 *   the subscription token to be used instead of a stale metered key.
 * - Streaming is incremental (NFR-1): partial `stream_event` deltas are emitted
 *   as `text` chunks as the SDK yields them.
 */

import { appendFileSync } from "node:fs";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import {
  AbortError,
  createSdkMcpServer,
  query,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKAssistantMessageError,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY,
} from "../constants.js";

/**
 * Name of the in-process MCP server used to surface DeepAgents' bound tools to
 * the Agent SDK. The SDK namespaces MCP tools as `mcp__<server>__<tool>`, so
 * this prefix is stripped when translating `tool_use` blocks back to LangChain
 * `tool_calls` and re-applied when matching a requested tool.
 */
const BRIDGE_MCP_SERVER_NAME = "openwiki_tools";

/**
 * Tool-name prefix the Agent SDK applies to tools served by
 * {@link BRIDGE_MCP_SERVER_NAME}. Used to round-trip tool names between the SDK
 * namespace and DeepAgents' un-namespaced tool identifiers.
 */
const BRIDGE_TOOL_PREFIX = `mcp__${BRIDGE_MCP_SERVER_NAME}__`;

/**
 * Appends a diagnostic line to the file named by `OPENWIKI_SDK_TRACE`, when
 * set. Exists because Agent SDK stream behavior can only be diagnosed from a
 * full run; the trace records every raw SDK message and every emitted chunk
 * without touching normal output. No-op (and never throws) when unset.
 *
 * @param kind - Short event tag (e.g. `message`, `chunk`, `stream-error`).
 * @param payload - JSON-serializable event detail; stringified best-effort.
 */
function traceSdk(kind: string, payload: unknown): void {
  const path = process.env.OPENWIKI_SDK_TRACE;
  if (!path) {
    return;
  }
  try {
    appendFileSync(
      path,
      `${JSON.stringify({ kind, payload })}\n`.slice(0, 20000),
    );
  } catch {
    // Tracing must never affect inference.
  }
}

/**
 * Call options accepted by {@link ChatClaudeAgentSdkModel}. Extends the base
 * chat-model options with the bound tool schemas DeepAgents attaches via
 * `bindTools`, which are bridged to the Agent SDK as MCP tools.
 */
export interface ChatClaudeAgentSdkCallOptions extends BaseChatModelCallOptions {
  /** Tool schemas bound by the caller (DeepAgents) via `bindTools`. */
  tools?: BindToolsInput[];
}

/**
 * Constructor parameters for {@link ChatClaudeAgentSdkModel}.
 */
export interface ChatClaudeAgentSdkModelParams extends BaseChatModelParams {
  /** Claude model id to request (e.g. `claude-sonnet-5`). */
  model: string;
  /**
   * Number of retry attempts for transient SDK failures, sourced from
   * `OPENWIKI_PROVIDER_RETRY_ATTEMPTS` for parity with other providers (NFR-3).
   * A value of `n` means up to `n` retries after the initial attempt.
   */
  maxRetries?: number;
}

/**
 * A minimal structural view of an Anthropic content block. The Agent SDK
 * re-exports the full `BetaMessage` type, but the adapter only needs to
 * discriminate text and `tool_use` blocks, so it narrows structurally to avoid
 * coupling to the vendored SDK's internal content-block union.
 */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * A minimal structural view over the Agent SDK message union covering only the
 * fields the adapter reads. The SDK's own union transitively references the
 * vendored Anthropic SDK content types, which the type-aware linter cannot
 * resolve; this local view keeps the translation code type-safe without
 * depending on those internals.
 */
interface SdkMessageView {
  type: string;
  subtype?: string;
  error?: SDKAssistantMessageError;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  message?: { content?: AnthropicContentBlock[] };
  /** Error strings carried by a non-success `result` message. */
  errors?: string[];
  /** Result text carried by a `result` message (error detail on failure). */
  result?: string;
}

/**
 * Mutable state threaded through one streamed generation.
 *
 * `emittedToolCalls` marks that tool_use chunks were already yielded, so the
 * deny-and-interrupt error result that ends such a turn is expected rather
 * than fatal. `nextToolBlockIndex` hands each tool call a content-block index
 * that is unique across the generation and never 0, because LangChain's
 * `convertChunksToEvents` keys blocks by index and streamed text occupies
 * block 0; a collision silently merges the tool call into the text block.
 */
interface TurnStreamState {
  /** True once a tool_call chunk has been yielded this generation. */
  emittedToolCalls: boolean;
  /** Next unique, non-zero content-block index for a tool call. */
  nextToolBlockIndex: number;
}

/**
 * SDK `SDKAssistantMessageError` values that represent transient conditions
 * worth retrying, as opposed to categorical auth/path failures that must
 * surface immediately to the user.
 */
const RETRYABLE_SDK_ERRORS: ReadonlySet<SDKAssistantMessageError> = new Set([
  "overloaded",
  "server_error",
]);

/**
 * Human-readable guidance for each categorical Agent SDK failure (FR-8). Every
 * message explains the token, model, and path relationship so a subscription
 * user understands why a model was rejected and how to proceed.
 */
const SDK_ERROR_GUIDANCE: Partial<Record<SDKAssistantMessageError, string>> = {
  authentication_failed:
    "the Claude Agent SDK rejected CLAUDE_CODE_OAUTH_TOKEN. Regenerate it with `claude setup-token` and confirm the anthropic-claude provider is selected.",
  oauth_org_not_allowed:
    "your Claude subscription organization is not permitted to use the Agent SDK path. Contact your workspace administrator.",
  billing_error:
    "the Claude subscription tied to CLAUDE_CODE_OAUTH_TOKEN cannot be billed for this request.",
  rate_limit:
    "the Claude subscription tied to CLAUDE_CODE_OAUTH_TOKEN is rate limited for this model. Retry shortly or select a different model.",
  model_not_found:
    "the requested model is not available to CLAUDE_CODE_OAUTH_TOKEN over the Agent SDK path. Choose Sonnet, Opus, Haiku, or Fable.",
  invalid_request:
    "the Agent SDK rejected the request. Verify the selected model id is valid for the anthropic-claude provider.",
};

/**
 * Builds the FR-8 guidance error for a categorical SDK failure, always naming
 * the token, the model, and the subscription path so the user can act.
 *
 * @param error - The SDK assistant-message error discriminator.
 * @param model - The Claude model id that was requested.
 * @returns An `Error` whose message explains the token/model/path relationship.
 */
function buildSdkGuidanceError(
  error: SDKAssistantMessageError,
  model: string,
  detail?: string,
): Error {
  const guidance =
    SDK_ERROR_GUIDANCE[error] ??
    "the Claude Agent SDK could not complete the request over the subscription path.";
  const detailSuffix = detail ? ` Underlying SDK detail: ${detail}` : "";
  return new Error(
    `Claude Agent SDK error (${error}) for model "${model}": ${guidance} ` +
      `The anthropic-claude provider authenticates with ${CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY} over the Agent SDK path, which unlocks the full Claude model lineup.` +
      detailSuffix,
  );
}

/**
 * Detects the error the Agent SDK iterator throws when a turn ends on an
 * error result. When the adapter has already captured `tool_use` blocks, this
 * is the EXPECTED terminal state: the deny-and-interrupt `canUseTool` policy
 * (which hands the tool loop back to DeepAgents) makes the SDK close the turn
 * with an error result instead of `success`, and the SDK surfaces that as a
 * thrown "Claude Code returned an error result" error.
 *
 * @param error - The value thrown by the Agent SDK message iterator.
 * @returns True when the error is the SDK's error-result wrapper.
 */
function isErrorResultWrapper(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Claude Code returned an error result")
  );
}

/**
 * Extracts the plain-text prompt content of a LangChain message, flattening
 * structured content parts into their text where present.
 *
 * @param message - The LangChain message to render.
 * @returns The message's textual content as a single string.
 */
function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : "text" in part && typeof part.text === "string"
          ? part.text
          : "",
    )
    .join("");
}

/**
 * Renders the LangChain message list into a single Agent SDK inference turn:
 * the system messages become the SDK `systemPrompt` (a custom string, which
 * also disables the default Claude Code system prompt), and the remaining
 * conversation is composed into one user prompt string preserving role and
 * tool-call context.
 *
 * The Agent SDK's `query()` entrypoint models a fresh turn rather than a
 * stateless multi-message chat, so prior assistant/tool turns are folded into
 * the composed prompt. This is the documented single-turn bridge the CR calls
 * for; DeepAgents re-sends the full running transcript on each call.
 *
 * @param messages - The inbound LangChain messages for this generation.
 * @returns The composed `systemPrompt` and user `prompt` strings.
 */
function composeTurn(messages: BaseMessage[]): {
  systemPrompt: string;
  prompt: string;
} {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const message of messages) {
    const type = message.getType();
    const text = messageText(message);
    if (type === "system") {
      systemParts.push(text);
      continue;
    }
    if (type === "ai") {
      const aiMessage = message as AIMessage;
      const toolCalls = aiMessage.tool_calls ?? [];
      const rendered =
        toolCalls.length > 0
          ? `Assistant (requested tools): ${toolCalls
              .map((call) => `${call.name}(${JSON.stringify(call.args)})`)
              .join(", ")}${text ? `\n${text}` : ""}`
          : `Assistant: ${text}`;
      conversationParts.push(rendered);
      continue;
    }
    if (type === "tool") {
      conversationParts.push(`Tool result: ${text}`);
      continue;
    }
    conversationParts.push(`User: ${text}`);
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    prompt: conversationParts.join("\n\n"),
  };
}

/**
 * Builds an in-process MCP server exposing DeepAgents' bound tools to the Agent
 * SDK so the model is told about them and can emit `tool_use` blocks. Handlers
 * are stubs: {@link ChatClaudeAgentSdkModel} denies-and-interrupts tool
 * execution so DeepAgents runs the tools itself and the SDK never invokes these
 * handlers.
 *
 * @param tools - The bound tool schemas from `bindTools`.
 * @returns An MCP server config, or `undefined` when no tools are bound.
 */
function buildToolBridge(
  tools: BindToolsInput[] | undefined,
): McpSdkServerConfigWithInstance | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const definitions = tools.map((boundTool) => {
    const name = extractToolName(boundTool);
    const description = extractToolDescription(boundTool);
    const shape = extractToolShape(boundTool);
    return tool(name, description, shape, () =>
      // Never reached: execution is denied-and-interrupted by canUseTool so
      // DeepAgents owns the tool-calling loop.
      Promise.resolve({ content: [{ type: "text", text: "" }] }),
    );
  });

  return createSdkMcpServer({
    name: BRIDGE_MCP_SERVER_NAME,
    tools: definitions,
  });
}

/**
 * Reads a bound tool's name from the several shapes LangChain accepts
 * (StructuredTool, `ToolDefinition`, or an object with a `name`).
 *
 * @param boundTool - The bound tool input.
 * @returns The tool's name, or a stable fallback when absent.
 */
function extractToolName(boundTool: BindToolsInput): string {
  const candidate = boundTool as {
    name?: string;
    function?: { name?: string };
  };
  return candidate.name ?? candidate.function?.name ?? "tool";
}

/**
 * Reads a bound tool's description across the shapes LangChain accepts.
 *
 * @param boundTool - The bound tool input.
 * @returns The tool's description, or an empty string when absent.
 */
function extractToolDescription(boundTool: BindToolsInput): string {
  const candidate = boundTool as {
    description?: string;
    function?: { description?: string };
  };
  return candidate.description ?? candidate.function?.description ?? "";
}

/**
 * Derives a Zod raw shape for the Agent SDK `tool()` helper from a bound tool's
 * schema. When the schema is a Zod object its `.shape` is used directly;
 * otherwise a permissive passthrough shape is returned, because the SDK only
 * needs a schema to describe the tool to the model and DeepAgents validates the
 * actual arguments itself.
 *
 * @param boundTool - The bound tool input.
 * @returns A Zod raw shape describing the tool's arguments.
 */
function extractToolShape(boundTool: BindToolsInput): z.ZodRawShape {
  const candidate = boundTool as {
    schema?: unknown;
  };
  let schema = candidate.schema;
  // Unwrap zod wrapper types until an object schema surfaces. DeepAgents wraps
  // several filesystem tool schemas in `z.preprocess(...)` (a zod v4 pipe),
  // which hides `.shape`; presenting the degraded fallback schema instead
  // makes the model emit wrongly-shaped arguments that DeepAgents rejects.
  for (let depth = 0; schema && typeof schema === "object" && depth < 10;) {
    if ("shape" in schema && typeof schema.shape === "object") {
      return schema.shape as z.ZodRawShape;
    }
    const def = (schema as { def?: Record<string, unknown> }).def;
    const inner = def?.out ?? def?.innerType ?? def?.schema;
    if (!inner || typeof inner !== "object") {
      break;
    }
    schema = inner;
    depth += 1;
  }
  // Permissive fallback: the SDK still names the tool to the model; DeepAgents
  // validates the arguments it receives.
  return { input: z.unknown().optional() };
}

/**
 * Strips the bridge MCP namespace from a tool name emitted by the Agent SDK so
 * the resulting `tool_call` matches the un-namespaced name DeepAgents bound.
 *
 * @param name - The (possibly namespaced) tool name from a `tool_use` block.
 * @returns The de-namespaced tool name.
 */
function stripToolPrefix(name: string): string {
  return name.startsWith(BRIDGE_TOOL_PREFIX)
    ? name.slice(BRIDGE_TOOL_PREFIX.length)
    : name;
}

/**
 * A LangChain `BaseChatModel` that performs inference through the Claude Agent
 * SDK. It exists so DeepAgents (`createDeepAgent({ model })`) can consume the
 * subscription-authenticated Claude runtime unchanged, mirroring how the
 * `openai-chatgpt` provider reuses a LangChain model class.
 */
export class ChatClaudeAgentSdkModel extends BaseChatModel<ChatClaudeAgentSdkCallOptions> {
  /** Claude model id requested for every generation. */
  private readonly model: string;

  /** Retry attempts for transient SDK failures (NFR-3). */
  private readonly maxRetries: number;

  /**
   * @param params - Model id, retry budget, and base chat-model params.
   */
  constructor(params: ChatClaudeAgentSdkModelParams) {
    super(params);
    this.model = params.model;
    this.maxRetries = params.maxRetries ?? 0;
  }

  /**
   * Identifies this model implementation to LangChain tracing/serialization.
   *
   * @returns The stable model-type discriminator.
   */
  _llmType(): string {
    return "claude-agent-sdk";
  }

  /**
   * Binds tool schemas for the next generation. DeepAgents calls this to attach
   * its tool definitions; they are carried through call options and bridged to
   * the Agent SDK as MCP tools at generation time.
   *
   * @param tools - Tool schemas to bind.
   * @param kwargs - Additional call options to bind alongside the tools.
   * @returns A runnable bound with the provided tools.
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatClaudeAgentSdkCallOptions>,
  ): Runnable<
    BaseLanguageModelInput,
    AIMessageChunk,
    ChatClaudeAgentSdkCallOptions
  > {
    return this.withConfig({
      tools,
      ...kwargs,
    });
  }

  /**
   * Validates that the subscription OAuth token is present. This is a
   * defense-in-depth fallback (FR-7); the primary, actionable FR-7 error is
   * emitted earlier by the provider-key guard in `src/agent/index.ts` before
   * the adapter is constructed.
   *
   * @throws {Error} When `CLAUDE_CODE_OAUTH_TOKEN` is missing or empty.
   */
  private assertToken(): void {
    const token = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY];
    if (!token || token.trim() === "") {
      throw new Error(
        `${CLAUDE_CODE_OAUTH_TOKEN_ENV_KEY} is required to run OpenWiki with the anthropic-claude provider. Generate one with \`claude setup-token\` and paste it during onboarding.`,
      );
    }
  }

  /**
   * Builds the Agent SDK environment for the subprocess, scrubbing
   * `ANTHROPIC_API_KEY` (FR-6). The SDK REPLACES the subprocess environment
   * when `env` is provided, so `process.env` is spread to retain inherited
   * variables while the metered key is stripped.
   *
   * @returns The environment map to hand the Agent SDK.
   */
  private buildSdkEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env[ANTHROPIC_API_KEY_ENV_KEY];
    return env;
  }

  /**
   * Assembles the Agent SDK `query()` options for a single, non-agentic
   * inference turn: the SDK's own tools, settings sources, and multi-turn loop
   * are all disabled so it acts purely as an authenticated model endpoint.
   *
   * @param systemPrompt - Composed system prompt string.
   * @param options - The parsed call options carrying bound tools and signal.
   * @returns The Agent SDK `query()` options.
   */
  private buildQueryOptions(
    systemPrompt: string,
    options: this["ParsedCallOptions"],
  ): Options {
    const bridge = buildToolBridge(options.tools);
    const abortController = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        abortController.abort();
      } else {
        options.signal.addEventListener(
          "abort",
          () => abortController.abort(),
          {
            once: true,
          },
        );
      }
    }

    return {
      model: this.model,
      systemPrompt: systemPrompt || undefined,
      tools: [],
      settingSources: [],
      maxTurns: 1,
      includePartialMessages: true,
      permissionMode: "default",
      env: this.buildSdkEnv(),
      abortController,
      ...(bridge ? { mcpServers: { [BRIDGE_MCP_SERVER_NAME]: bridge } } : {}),
      // Deny-and-interrupt every tool call so the SDK never executes tools;
      // DeepAgents owns the tool-calling loop from the returned tool_calls.
      canUseTool: () =>
        Promise.resolve({
          behavior: "deny",
          message: "OpenWiki executes tools via DeepAgents, not the Agent SDK.",
          interrupt: true,
        }),
    };
  }

  /**
   * Streams a single inference turn, translating the Agent SDK message stream
   * into LangChain `ChatGenerationChunk`s: partial `stream_event` text deltas
   * become incremental text chunks (NFR-1), and `tool_use` blocks in the final
   * assistant message become `tool_call_chunks`. Categorical SDK failures are
   * mapped to FR-8 guidance errors.
   *
   * @param messages - The inbound LangChain messages.
   * @param options - Parsed call options (bound tools, abort signal).
   * @param runManager - Callback manager for streaming token callbacks.
   * @yields `ChatGenerationChunk`s carrying text and tool-call deltas.
   * @throws {Error} On categorical auth/path SDK failures (FR-8) or a missing
   * token (FR-7 fallback).
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.assertToken();
    const { systemPrompt, prompt } = composeTurn(messages);

    let attempt = 0;
    // Retry only transient failures before any chunk is emitted; once tokens
    // have streamed, a retry would duplicate output, so failures propagate.
    for (;;) {
      let yieldedAny = false;
      const turnState: TurnStreamState = {
        emittedToolCalls: false,
        nextToolBlockIndex: 1,
      };
      try {
        const stream = query({
          prompt,
          options: this.buildQueryOptions(systemPrompt, options),
        });

        for await (const message of stream) {
          traceSdk("message", message);
          const chunk = this.translateMessage(message, turnState);
          if (!chunk) {
            continue;
          }
          yieldedAny = true;
          if ((chunk.message as AIMessageChunk).tool_call_chunks?.length) {
            turnState.emittedToolCalls = true;
          }
          traceSdk("chunk", {
            text: chunk.text,
            toolCallChunks: (chunk.message as AIMessageChunk).tool_call_chunks,
          });
          if (chunk.text) {
            await runManager?.handleLLMNewToken(chunk.text);
          }
          yield chunk;
        }
        traceSdk("stream-end", {
          emittedToolCalls: turnState.emittedToolCalls,
        });
        return;
      } catch (error) {
        traceSdk("stream-error", {
          emittedToolCalls: turnState.emittedToolCalls,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof AbortError) {
          throw error;
        }
        // The deny-and-interrupt canUseTool policy ends a tool-calling turn
        // with an SDK error result; the tool_use chunks are already yielded,
        // so the turn is complete and the wrapper error must not surface.
        if (turnState.emittedToolCalls && isErrorResultWrapper(error)) {
          return;
        }
        const retryable =
          !yieldedAny && attempt < this.maxRetries && isRetryableError(error);
        if (!retryable) {
          throw error;
        }
        attempt += 1;
      }
    }
  }

  /**
   * Translates a single Agent SDK message into a `ChatGenerationChunk`, or
   * `undefined` for control/status messages that carry no assistant output.
   * Text is emitted from partial `stream_event` deltas; the final assistant
   * message contributes only `tool_use` blocks (to avoid double-counting text)
   * and surfaces categorical errors.
   *
   * @param message - The Agent SDK stream message.
   * @param turnState - Mutable per-generation stream state: whether tool_use
   * chunks were already emitted (a non-success result is then the expected
   * deny-and-interrupt terminal state and is swallowed instead of thrown) and
   * the next unique content-block index to assign to a tool call.
   * @returns A generation chunk, or `undefined` when there is nothing to emit.
   * @throws {Error} When the message carries a categorical SDK error (FR-8).
   */
  private translateMessage(
    message: SDKMessage,
    turnState: TurnStreamState,
  ): ChatGenerationChunk | undefined {
    // The SDK message union references the vendored Anthropic SDK's content
    // types, which the type-aware linter cannot fully resolve; narrow through a
    // minimal local structural view to keep the translation type-safe.
    const view = message as unknown as SdkMessageView;

    if (view.type === "stream_event") {
      const event = view.event;
      if (
        event?.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string" &&
        event.delta.text.length > 0
      ) {
        return new ChatGenerationChunk({
          text: event.delta.text,
          message: new AIMessageChunk({ content: event.delta.text }),
        });
      }
      return undefined;
    }

    if (view.type === "assistant") {
      if (view.error) {
        throw buildSdkGuidanceError(view.error, this.model);
      }
      const content = view.message?.content ?? [];
      // Block indices must be unique across the WHOLE generation and must
      // never be 0: LangChain's convertChunksToEvents keys content blocks by
      // index, and streamed text always occupies block 0. A colliding index
      // makes the tool call silently merge into the text block and vanish,
      // which terminated the DeepAgents loop on every mixed text-plus-tool
      // turn.
      const toolCallChunks = content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          name: stripToolPrefix(block.name ?? ""),
          args: JSON.stringify(block.input ?? {}),
          id: block.id,
          index: turnState.nextToolBlockIndex++,
          type: "tool_call_chunk" as const,
        }));
      if (toolCallChunks.length === 0) {
        return undefined;
      }
      return new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: toolCallChunks,
        }),
      });
    }

    if (view.type === "result" && view.subtype !== "success") {
      // A tool-calling turn intentionally ends on an error result: the
      // deny-and-interrupt canUseTool policy interrupts the SDK loop after the
      // tool_use blocks are captured, so this is success from the adapter's
      // perspective, not a failure.
      if (turnState.emittedToolCalls) {
        return undefined;
      }
      const detail = [view.subtype, ...(view.errors ?? []), view.result]
        .filter(Boolean)
        .join("; ");
      throw buildSdkGuidanceError("unknown", this.model, detail || undefined);
    }

    return undefined;
  }

  /**
   * Runs a full (non-streaming) generation by consuming the streaming path and
   * concatenating the chunks, so the two code paths never diverge.
   *
   * @param messages - The inbound LangChain messages.
   * @param options - Parsed call options.
   * @param runManager - Callback manager for token callbacks.
   * @returns The aggregated chat result with text and tool calls.
   */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let aggregate: ChatGenerationChunk | undefined;
    for await (const chunk of this._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      aggregate = aggregate ? aggregate.concat(chunk) : chunk;
    }

    const finalChunk =
      aggregate ??
      new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({ content: "" }),
      });

    const finalMessage = finalChunk.message as AIMessageChunk;
    return {
      generations: [
        {
          text: finalChunk.text,
          message: new AIMessage({
            content: finalMessage.content,
            tool_calls: finalMessage.tool_calls,
          }),
        },
      ],
    };
  }
}

/**
 * Determines whether an error thrown by the Agent SDK represents a transient
 * condition worth retrying, based on its embedded assistant-message error code
 * when present.
 *
 * @param error - The thrown error.
 * @returns `true` when the error is transient and safe to retry.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    for (const code of RETRYABLE_SDK_ERRORS) {
      if (error.message.includes(code)) {
        return true;
      }
    }
  }
  return false;
}
