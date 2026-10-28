import type { ProviderModel } from "../types";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type ModelMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; content: string };
export type SendInput = {
  key: string;
  model: string;
  system: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
};
export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  complete: boolean;
};
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "tool"; call: ToolCall };
export type SendResult = { text: string; usage: Usage };
export interface Provider {
  id: string;
  label: string;
  company: string;
  keyPrefix: string;
  consoleUrl: string;
  keyInstructions: string[];
  subscription: string;
  defaultModel: string;
  acceptsModel(model: string): boolean;
  fallbackModels: ProviderModel[];
  listModels(key: string, signal?: AbortSignal): Promise<ProviderModel[]>;
  validateKey(
    key: string,
    signal?: AbortSignal,
    send?: (input: SendInput) => Promise<SendResult>,
  ): Promise<void>;
  countTokens?(input: SendInput): Promise<number>;
  send(input: SendInput): Promise<SendResult>;
  stream(input: SendInput): AsyncGenerator<StreamEvent>;
}
