import Anthropic from "@anthropic-ai/sdk";

const OLLAMA_NUM_CTX = 8192;
const ANTHROPIC_MAX_TOKENS = 16000;

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export interface LlmProvider {
  readonly name: string;
  /** True if content leaves this machine. */
  readonly hosted: boolean;
  /** Returns the model's raw JSON text. The caller validates it. */
  generateJson(request: JsonRequest): Promise<string>;
}

export class OllamaProvider implements LlmProvider {
  readonly hosted = false;
  readonly name: string;

  constructor(
    private readonly model: string,
    private readonly baseUrl: string,
  ) {
    this.name = `ollama:${model}`;
  }

  async generateJson(request: JsonRequest): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        // Measured on qwen3: faster, and it kept more real memories.
        think: false,
        format: request.schema,
        options: { temperature: 0, num_ctx: OLLAMA_NUM_CTX },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { message: { content: string } };
    return body.message.content;
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly hosted = true;
  readonly name: string;
  private readonly client = new Anthropic();

  constructor(private readonly model: string) {
    this.name = `anthropic:${model}`;
  }

  async generateJson(request: JsonRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: {
        format: { type: "json_schema", schema: request.schema },
      },
    });
    if (response.stop_reason !== "end_turn") {
      throw new Error(`Claude stopped early: ${response.stop_reason}`);
    }
    return response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }
}

/** Parses DISTILL_MODEL, such as "ollama:qwen3" or "anthropic:claude-opus-5-5". */
export function createProvider(spec: string, ollamaUrl: string): LlmProvider {
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const model = spec.slice(separator + 1);
  if (separator < 1 || model.length === 0) {
    throw new Error(`DISTILL_MODEL "${spec}" must look like provider:model`);
  }
  if (provider === "ollama") return new OllamaProvider(model, ollamaUrl);
  if (provider === "anthropic") return new AnthropicProvider(model);
  throw new Error(`Unknown provider "${provider}" in DISTILL_MODEL`);
}
