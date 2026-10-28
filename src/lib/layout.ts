import type { WorkspaceLayout } from "./types";
export const defaultLayout: WorkspaceLayout = {
  mode: "1",
  activeId: null,
  order: [],
  pinned: [],
  collapsed: [],
  layouts: {},
};
export function parseLayout(raw: string): WorkspaceLayout {
  try {
    return { ...defaultLayout, ...JSON.parse(raw) };
  } catch {
    return { ...defaultLayout };
  }
}
