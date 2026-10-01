import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

type JsonSchema = Record<string, unknown>;

/** One-shot text completion with the provider chosen in config. */
export async function complete(system: string, user: string): Promise<string> {
  return (await call(system, user)).trim();
}

/**
 * Completion constrained to a JSON schema. Keep schemas to the subset both providers accept:
 * objects with all fields required and additionalProperties: false, strings, integers, enums, arrays.
 */
export async function completeJson<T>(system: string, user: string, schema: JsonSchema): Promise<T> {
  const text = await call(system, user, schema);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Model returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function call(system: string, user: string, schema?: JsonSchema): Promise<string> {
  return config.llm.provider === "claude" ? callClaude(system, user, schema) : callGemini(system, user, schema);
}

async function callClaude(system: string, user: string, schema?: JsonSchema): Promise<string> {
  if (!config.llm.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey: config.llm.anthropicApiKey });

  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    ...(schema && { output_config: { format: { type: "json_schema", schema } } }),
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude refused: ${JSON.stringify(response.stop_details)}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude response truncated (max_tokens)");
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  if (!text.trim()) throw new Error(`Empty Claude response (stop_reason: ${response.stop_reason})`);
  return text;
}

async function callGemini(system: string, user: string, schema?: JsonSchema): Promise<string> {
  if (!config.llm.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: config.llm.geminiApiKey });

  const response = await ai.models.generateContent({
    model: config.llm.model,
    contents: user,
    config: {
      systemInstruction: system,
      ...(schema && { responseMimeType: "application/json", responseJsonSchema: schema }),
    },
  });

  const text = response.text;
  if (!text?.trim()) {
    const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
    throw new Error(`Empty Gemini response (reason: ${reason ?? "unknown"})`);
  }
  return text;
}
