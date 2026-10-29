export type ProviderModel = { id: string; name: string; temperature: boolean };
export type PublicMessage = {
  id: string;
  role: string;
  text: string;
  status: string;
  createdAt: string;
  origin?: string;
  proposalId?: string | null;
};
export type AgentView = {
  id: string;
  name: string;
  engine?: "api" | "claude-code" | "codex";
  projectPath?: string;
  nativeSessionId?: string | null;
  terminalStarted?: boolean;
  terminalState?: string;
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
  kind?: string;
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
  orchestrator: AgentView | null;
  proposals: ProposalView[];
  pendingProposalCount: number;
  budgets: BudgetView[];
  autopilot: false;
};
export type AgentConfig = Pick<
  AgentView,
  | "name"
  | "engine"
  | "projectPath"
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
export type ProposalPayload =
  | { action: "send_message"; agentId: string; text: string }
  | { action: "create_agent"; config: AgentConfig }
  | { action: "rename_agent"; agentId: string; name: string }
  | { action: "pause_agent" | "archive_agent"; agentId: string };
export type ProposalView = {
  id: string;
  action: string;
  agentId: string | null;
  payload: ProposalPayload;
  status: string;
  version: number;
  approvedBy: boolean;
  createdAt: string;
  resultRunId: string | null;
  error: string | null;
};
export type BudgetView = {
  provider: string;
  label: string;
  period: string;
  limit: number | null;
  spent: number;
  reserved: number;
  unknownCalls: number;
  warning: boolean;
  blocked: boolean;
  pricedModels: string[];
};
export type AuditView = {
  id: string;
  actor: string;
  action: string;
  subjectId: string | null;
  proposalId: string | null;
  approvedBy: boolean;
  details: Record<string, unknown>;
  createdAt: string;
};
