export type ProviderModel = { id: string; name: string; temperature: boolean };
export type PublicMessage = {
  id: string;
  role: string;
  text: string;
  status: string;
  createdAt: string;
};
export type AgentView = {
  id: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  color: string;
  icon: string;
  demo: boolean;
  conversation: {
    id: string;
    activeRunId: string | null;
    messages: PublicMessage[];
    runs: RunView[];
  };
};
export type RunView = {
  id: string;
  assistantId: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  usageComplete: boolean;
  errorCode: string | null;
};
export type Workspace = {
  selfHost: boolean;
  email: string;
  provider: { connected: boolean; last4: string | null };
  agents: AgentView[];
  pricingDate: string;
};
