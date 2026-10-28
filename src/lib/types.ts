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
  paused: boolean;
  archived: boolean;
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
  provider: string;
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
  providers: ProviderInfo[];
  templates: AgentTemplate[];
  layout: WorkspaceLayout;
  agents: AgentView[];
  pricingDate: string;
};
export type AgentConfig = Pick<
  AgentView,
  | "name"
  | "provider"
  | "model"
  | "systemPrompt"
  | "temperature"
  | "maxTokens"
  | "color"
  | "icon"
>;
export type AgentTemplate = { id: string; name: string; config: AgentConfig };
export type ProviderInfo = {
  id: string;
  label: string;
  company: string;
  keyPrefix: string;
  consoleUrl: string;
  keyInstructions: string[];
  subscription: string;
  defaultModel: string;
  connected: boolean;
  last4: string | null;
};
export type LayoutMode = "1" | "2" | "4" | "6" | "tabs";
export type PanelLayout = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
export type WorkspaceLayout = {
  mode: LayoutMode;
  activeId: string | null;
  order: string[];
  pinned: string[];
  collapsed: string[];
  layouts: Record<string, PanelLayout[]>;
};
export type RunPatch = {
  agentId: string;
  runId: string;
  assistantId: string;
  model: string;
  provider: string;
  text: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  usageComplete: boolean;
  errorCode: string | null;
  createdAt: string;
};
export type LiveEvent =
  | { type: "change" }
  | { type: "run"; run: RunPatch }
  | { type: "unauthorized" };
