"use client";
import { useEffect, useRef, useState } from "react";
import GridLayout, { type Layout } from "react-grid-layout/legacy";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  LoaderCircle,
  Plus,
  RotateCcw,
} from "lucide-react";
import type {
  AgentView,
  LayoutMode,
  PanelLayout,
  WorkspaceLayout,
} from "@/lib/types";
import type { useWorkspace } from "./use-workspace";
import { AgentPanel } from "./agent-panel";
type WorkspaceState = ReturnType<typeof useWorkspace>;
export function WorkspaceBoard({
  workspace,
  onNew,
  onEdit,
}: {
  workspace: WorkspaceState;
  onNew: () => void;
  onEdit: (agent: AgentView) => void;
}) {
  const {
    agents,
    data,
    layout,
    updateLayout,
    saving,
    pending,
    chatErrors,
    send,
    stop,
    models,
    setNotice,
  } = workspace;
  const active = agents.filter((a) => !a.archived);
  const ordered = [
    ...new Set([...layout.pinned, ...layout.order, ...active.map((a) => a.id)]),
  ].flatMap((id) => {
    const agent = active.find((a) => a.id === id);
    return agent ? [agent] : [];
  });
  const selected = ordered.find((a) => a.id === layout.activeId) ?? ordered[0];
  const capacity = layout.mode === "tabs" ? 1 : Number(layout.mode);
  const page = Math.floor(
    Math.max(
      0,
      ordered.findIndex((a) => a.id === selected?.id),
    ) / capacity,
  );
  const visible = ordered.slice(page * capacity, page * capacity + capacity);
  const single = capacity === 1;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    wrap.current?.scrollTo({ top: 0 });
  }, [layout.mode, page]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
      setHeight(entries[0].contentRect.height);
    });
    if (wrap.current) observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  const columns =
    width < 650 ? 1 : width < 1000 ? 2 : layout.mode === "6" ? 3 : 2;
  const narrow = width < 650;
  const columnsWidth = 12 / columns;
  const rows = capacity === 2 ? 1 : 2;
  const defaultHeight = Math.max(
    5,
    Math.floor(((height - (rows - 1) * 14) / rows + 14) / 46),
  );
  const saved = layout.layouts[layout.mode] ?? [];
  const grid = visible.map((agent, index) => {
    const stored = saved.find((item) => item.i === agent.id);
    const collapsed = layout.collapsed.includes(agent.id);
    return {
      i: agent.id,
      x: narrow ? 0 : (stored?.x ?? (index % columns) * columnsWidth),
      y: narrow
        ? index * 8
        : (stored?.y ?? Math.floor(index / columns) * defaultHeight),
      w: narrow ? 12 : (stored?.w ?? columnsWidth),
      h: collapsed ? 2 : narrow ? 8 : Math.max(5, stored?.h ?? defaultHeight),
      minW: 3,
      minH: collapsed ? 2 : 5,
      maxH: 40,
      isResizable: !collapsed && !narrow,
    };
  });
  function persist(items: Layout) {
    const ids = new Set(visible.map((a) => a.id));
    updateLayout({
      ...layout,
      layouts: {
        ...layout.layouts,
        [layout.mode]: [
          ...saved.filter((item) => !ids.has(item.i)),
          ...items.map(({ i, x, y, w, h }) => ({
            i,
            x,
            y,
            w,
            h: layout.collapsed.includes(i)
              ? (saved.find((item) => item.i === i)?.h ?? defaultHeight)
              : h,
          })),
        ],
      },
    });
  }
  function move(agentId: string, direction: number) {
    const ids = ordered.map((a) => a.id);
    const at = ids.indexOf(agentId),
      to = Math.max(0, Math.min(ids.length - 1, at + direction));
    [ids[at], ids[to]] = [ids[to], ids[at]];
    updateLayout({
      ...layout,
      order: ids,
      activeId: agentId,
      pinned: layout.pinned.filter((id) => id !== agentId),
      layouts: { ...layout.layouts, [layout.mode]: [] },
    });
  }
  function toggle(field: "pinned" | "collapsed", id: string) {
    updateLayout({
      ...layout,
      [field]: layout[field].includes(id)
        ? layout[field].filter((value) => value !== id)
        : [...layout[field], id],
    });
  }
  function resizeKey(event: React.KeyboardEvent<HTMLElement>) {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    const id = event.currentTarget
      .closest("[data-agent-id]")
      ?.getAttribute("data-agent-id");
    const items = grid.map((item) =>
      item.i !== id
        ? item
        : {
            ...item,
            w: Math.max(
              3,
              Math.min(
                12 - item.x,
                item.w +
                  (event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : 0),
              ),
            ),
            h: Math.max(
              5,
              Math.min(
                40,
                item.h +
                  (event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : 0),
              ),
            ),
          },
    );
    persist(items);
  }
  const panel = (agent: AgentView) => (
    <AgentPanel
      agent={agent}
      provider={data!.providers.find((p) => p.id === agent.provider)!}
      modelName={
        models[agent.provider]?.models.find((m) => m.id === agent.model)
          ?.name ?? agent.model
      }
      compact={!single}
      pinned={layout.pinned.includes(agent.id)}
      collapsed={layout.collapsed.includes(agent.id)}
      pending={!!pending[agent.id]}
      error={chatErrors[agent.id]}
      onEdit={() => onEdit(agent)}
      onPin={() => toggle("pinned", agent.id)}
      onCollapse={() => toggle("collapsed", agent.id)}
      onFocus={() =>
        updateLayout({
          ...layout,
          mode: "1",
          activeId: agent.id,
          collapsed: layout.collapsed.filter((id) => id !== agent.id),
        })
      }
      onMove={(direction) => move(agent.id, direction)}
      send={(text, mode, messageId) => send(agent.id, text, mode, messageId)}
      stop={() => stop(agent)}
      notify={setNotice}
    />
  );
  return (
    <div className="workspace-board">
      <div className="board-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h1>A little more perspective.</h1>
          <p>
            {active.length} {active.length === 1 ? "agent" : "agents"}
            <span>·</span>
            {agents.filter((a) => a.conversation.activeRunId).length} thinking
            <span>·</span>
            <span
              className={
                workspace.connected ? "live-connected" : "live-reconnecting"
              }
            >
              {workspace.connected ? "Live" : "Reconnecting…"}
            </span>
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          <Plus size={15} />
          New agent
        </button>
      </div>
      <div className="board-toolbar">
        <div
          className="layout-controls"
          role="group"
          aria-label="Workspace layout"
        >
          <LayoutGrid size={15} />
          {(["1", "2", "4", "6", "tabs"] as LayoutMode[]).map((mode) => (
            <button
              key={mode}
              className={layout.mode === mode ? "selected" : ""}
              aria-label={
                mode === "tabs" ? "Tabbed layout" : `${mode}-up layout`
              }
              aria-pressed={layout.mode === mode}
              onClick={() => updateLayout({ ...layout, mode })}
            >
              {mode === "tabs" ? "Tabs" : mode}
            </button>
          ))}
        </div>
        <div className="board-toolbar-right">
          <span className="layout-saved" role="status">
            {saving ? (
              <>
                <LoaderCircle className="spin" size={12} />
                Saving…
              </>
            ) : (
              <>
                <Check size={12} />
                Layout saved
              </>
            )}
          </span>
          <button
            className="icon-button"
            aria-label="Reset panel positions"
            title="Reset panel positions"
            onClick={() =>
              updateLayout({
                ...layout,
                layouts: { ...layout.layouts, [layout.mode]: [] },
                collapsed: [],
              })
            }
          >
            <RotateCcw size={14} />
          </button>
          {ordered.length > capacity && layout.mode !== "tabs" && (
            <div className="board-pages">
              <button
                className="icon-button"
                aria-label="Previous agents"
                disabled={page === 0}
                onClick={() =>
                  updateLayout({
                    ...layout,
                    activeId: ordered[(page - 1) * capacity].id,
                  })
                }
              >
                <ChevronLeft size={15} />
              </button>
              <span>
                {page + 1} / {Math.ceil(ordered.length / capacity)}
              </span>
              <button
                className="icon-button"
                aria-label="Next agents"
                disabled={(page + 1) * capacity >= ordered.length}
                onClick={() =>
                  updateLayout({
                    ...layout,
                    activeId: ordered[(page + 1) * capacity].id,
                  })
                }
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      </div>
      {layout.mode === "tabs" && (
        <div
          className="agent-tabs"
          role="tablist"
          aria-label="Agent conversations"
        >
          {ordered.map((agent) => (
            <button
              role="tab"
              aria-selected={selected?.id === agent.id}
              key={agent.id}
              onClick={() => updateLayout({ ...layout, activeId: agent.id })}
            >
              {layout.pinned.includes(agent.id) ? "⌖ " : ""}
              {agent.name}
              {agent.conversation.activeRunId && <span className="tiny-dot" />}
            </button>
          ))}
        </div>
      )}
      <div
        className={`board-content ${single ? "single-board" : ""}`}
        ref={wrap}
      >
        {!ordered.length ? (
          <div className="welcome">
            <span className="welcome-mark">
              <Plus size={30} />
            </span>
            <h2>Meet your first agent.</h2>
            <p>Give it a role, bring a question, and see where it goes.</p>
            <button className="primary" onClick={onNew}>
              Create an agent
            </button>
          </div>
        ) : single ? (
          <div className="single-agent" key={selected.id}>
            {panel(selected)}
          </div>
        ) : (
          width > 0 && (
            <GridLayout
              width={width}
              cols={12}
              rowHeight={32}
              margin={[14, 14]}
              containerPadding={[0, 0]}
              layout={grid}
              draggableHandle=".panel-grip"
              draggableCancel="textarea,input,select,.panel-controls,.send-button"
              isDraggable={!narrow}
              isResizable={!narrow}
              onDragStop={persist}
              onResizeStop={persist}
              resizeHandle={(_axis, ref) => (
                <span
                  ref={ref}
                  className="react-resizable-handle react-resizable-handle-se"
                  role="button"
                  tabIndex={0}
                  aria-label="Resize agent panel"
                  title="Drag to resize · Arrow keys to resize"
                  onKeyDown={resizeKey}
                />
              )}
            >
              {visible.map((agent) => (
                <div key={agent.id} data-agent-id={agent.id}>
                  {panel(agent)}
                </div>
              ))}
            </GridLayout>
          )
        )}
      </div>
    </div>
  );
}
