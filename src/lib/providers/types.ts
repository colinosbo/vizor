import type { ProviderModel } from "../types";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type SendInput = {
  key: string;
  model: string;
  system: string;
  messages: ChatMessage[];
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
  { type: "delta"; text: string } | { type: "usage"; usage: Usage };
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
  validateKey(key: string, signal?: AbortSignal): Promise<void>;
  send(input: SendInput): Promise<{ text: string; usage: Usage }>;
  stream(input: SendInput): AsyncGenerator<StreamEvent>;
}
