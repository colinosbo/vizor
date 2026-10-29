export type TerminalEngine = "claude-code" | "codex";
export type TerminalState = {
  agentId: string;
  token?: string;
  state: "running" | "stopped";
  nativeSessionId?: string;
  projectPath?: string;
  exitCode?: number | null;
  sequence?: number;
  data?: string;
  conflict?: boolean;
};
export type TerminalEvent = TerminalState & {
  type: "state" | "data" | "install";
  engine?: TerminalEngine;
  progress?: number | null;
};
export type TerminalBridge = {
  tools(): Promise<{ engine: TerminalEngine; installed: boolean }[]>;
  install(engine: TerminalEngine): Promise<{ installed: boolean }>;
  setup(engine: TerminalEngine): Promise<TerminalState>;
  chooseFolder(): Promise<string | null>;
  start(agentId: string, confirmShared?: boolean): Promise<TerminalState>;
  snapshot(agentId: string): Promise<TerminalState>;
  input(agentId: string, token: string, data: string): Promise<void>;
  resize(
    agentId: string,
    token: string,
    cols: number,
    rows: number,
  ): Promise<void>;
  interrupt(agentId: string, token: string): Promise<void>;
  stop(agentId: string, token: string): Promise<void>;
  onEvent(callback: (event: TerminalEvent) => void): () => void;
};
