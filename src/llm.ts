import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

/** One-shot text completion with the provider chosen in config. */
export async function complete(system: string, user: string): Promise<string> {
  const text = config.llm.provider === "claude" ? await completeClaude(system, user) : await completeGemini(system, user);
  return text.trim();
}

async function completeClaude(system: string, user: string): Promise<string> {
  if (!config.llm.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey: config.llm.anthropicApiKey });

  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claude refused: ${JSON.stringify(response.stop_details)}`);
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  if (!text.trim()) throw new Error(`Empty Claude response (stop_reason: ${response.stop_reason})`);
  return text;
}

async function completeGemini(system: string, user: string): Promise<string> {
  if (!config.llm.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: config.llm.geminiApiKey });

  const response = await ai.models.generateContent({
    model: config.llm.model,
    contents: user,
    config: { systemInstruction: system },
  });

  const text = response.text;
  if (!text?.trim()) {
    const reason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
    throw new Error(`Empty Gemini response (reason: ${reason ?? "unknown"})`);
  }
  return text;
}
