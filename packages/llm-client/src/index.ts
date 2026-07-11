export type LlmProvider = "claude" | "openai" | "grok" | "mock";

export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmCompletion {
  text: string;
  tool_calls: LlmToolCall[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "error";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  raw?: unknown;
}

export interface LlmCompleteOptions {
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
  max_tokens?: number;
  temperature?: number;
}

export interface LlmClient {
  provider: LlmProvider;
  model: string;
  complete(options: LlmCompleteOptions): Promise<LlmCompletion>;
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  claude: "claude-sonnet-4-5",
  openai: "gpt-4o",
  grok: "grok-3",
  mock: "mock-1",
};

export interface CreateLlmClientOptions {
  provider?: LlmProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function resolveProvider(value: string | undefined): LlmProvider {
  const lowered = (value ?? "").toLowerCase();
  if (lowered === "claude" || lowered === "anthropic") return "claude";
  if (lowered === "openai" || lowered === "gpt") return "openai";
  if (lowered === "grok" || lowered === "xai") return "grok";
  if (lowered === "mock" || lowered === "noop") return "mock";
  return "mock";
}

export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  const provider = options.provider ?? resolveProvider(process.env.LLM_PROVIDER);
  const apiKey = options.apiKey ?? resolveApiKey(provider);
  const model = options.model ?? DEFAULT_MODELS[provider];

  if (provider === "claude") return createClaudeClient({ apiKey, model, baseUrl: options.baseUrl });
  if (provider === "openai") return createOpenAiClient({ apiKey, model, baseUrl: options.baseUrl });
  if (provider === "grok") return createGrokClient({ apiKey, model, baseUrl: options.baseUrl });
  return createMockClient({ model });
}

function resolveApiKey(provider: LlmProvider): string | undefined {
  if (provider === "claude") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "grok") return process.env.XAI_API_KEY ?? process.env.GROK_API_KEY;
  return undefined;
}

interface ProviderConfig {
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

function createClaudeClient(config: ProviderConfig): LlmClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  return {
    provider: "claude",
    model: config.model,
    async complete(options) {
      if (!config.apiKey) throw new LlmClientError("missing ANTHROPIC_API_KEY", "claude");
      const body = {
        model: config.model,
        max_tokens: options.max_tokens ?? 4096,
        temperature: options.temperature ?? 0.2,
        system: options.system,
        messages: options.messages.map((msg) => ({ role: msg.role === "system" ? "user" : msg.role, content: msg.content })),
        tools: (options.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
      };
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new LlmClientError(`claude api ${response.status}: ${errText.slice(0, 500)}`, "claude");
      }
      const data = (await response.json()) as ClaudeResponse;
      return parseClaudeResponse(data);
    },
  };
}

interface ClaudeResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function parseClaudeResponse(data: ClaudeResponse): LlmCompletion {
  const text = data.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const tool_calls: LlmToolCall[] = data.content
    .filter((block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
  return {
    text,
    tool_calls,
    stop_reason: mapStopReason(data.stop_reason),
    usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
    raw: data,
  };
}

function createOpenAiClient(config: ProviderConfig): LlmClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com";
  return {
    provider: "openai",
    model: config.model,
    async complete(options) {
      if (!config.apiKey) throw new LlmClientError("missing OPENAI_API_KEY", "openai");
      const messages: Array<Record<string, unknown>> = [];
      if (options.system) messages.push({ role: "system", content: options.system });
      for (const msg of options.messages) messages.push({ role: msg.role, content: msg.content });
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        max_tokens: options.max_tokens ?? 4096,
        temperature: options.temperature ?? 0.2,
      };
      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
        }));
      }
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new LlmClientError(`openai api ${response.status}: ${errText.slice(0, 500)}`, "openai");
      }
      const data = (await response.json()) as OpenAiResponse;
      return parseOpenAiResponse(data);
    },
  };
}

interface OpenAiResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

function parseOpenAiResponse(data: OpenAiResponse): LlmCompletion {
  const choice = data.choices[0];
  if (!choice) throw new LlmClientError("openai response missing choices", "openai");
  const text = choice.message.content ?? "";
  const tool_calls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((call) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = { raw_arguments: call.function.arguments };
    }
    return { id: call.id, name: call.function.name, input };
  });
  return {
    text,
    tool_calls,
    stop_reason: mapStopReason(choice.finish_reason),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
    raw: data,
  };
}

function createGrokClient(config: ProviderConfig): LlmClient {
  const baseUrl = config.baseUrl ?? "https://api.x.ai";
  const openai = createOpenAiClient({ ...config, baseUrl });
  return {
    provider: "grok",
    model: config.model,
    complete: (options) => openai.complete(options),
  };
}

function createMockClient(config: { model: string }): LlmClient {
  return {
    provider: "mock",
    model: config.model,
    async complete(options) {
      const lastUser = [...options.messages].reverse().find((msg) => msg.role === "user");
      const text = lastUser
        ? `[mock] received ${options.messages.length} messages; tools available: ${(options.tools ?? []).map((t) => t.name).join(", ") || "none"}. Last user prompt: ${lastUser.content.slice(0, 200)}`
        : "[mock] no messages provided";
      return {
        text,
        tool_calls: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: text.length },
      };
    },
  };
}

function mapStopReason(reason: string | undefined): LlmCompletion["stop_reason"] {
  if (reason === "end_turn" || reason === "stop") return "end_turn";
  if (reason === "tool_use" || reason === "tool_calls") return "tool_use";
  if (reason === "max_tokens" || reason === "length") return "max_tokens";
  return "end_turn";
}

export class LlmClientError extends Error {
  provider: LlmProvider;
  constructor(message: string, provider: LlmProvider) {
    super(message);
    this.name = "LlmClientError";
    this.provider = provider;
  }
}
