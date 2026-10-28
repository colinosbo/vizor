"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Check, LoaderCircle, ShieldCheck } from "lucide-react";
import type { BudgetView } from "@/lib/types";
import { api, type useWorkspace } from "./use-workspace";
const currency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
type LedgerRow = {
  id: string;
  provider: string;
  model: string;
  source: string;
  status: string;
  quoted: number | null;
  charged: number | null;
  estimated: boolean;
  createdAt: string;
};
export function SpendingView({
  workspace,
}: {
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [entries, setEntries] = useState<LedgerRow[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    void api<{ entries: LedgerRow[] }>("spending")
      .then((result) => setEntries(result.entries))
      .catch((e) => setError(e.message));
  }, [workspace.data]);
  return (
    <div className="collection-view spending-view">
      <div className="page-eyebrow">
        <span className="eyebrow-line" />
        KEEP IT WITHIN REACH
      </div>
      <h1>Set your boundaries.</h1>
      <p>
        One monthly limit per provider. Agent chats, orchestrator calls and
        connection tests share it.
      </p>
      <div className="budget-grid">
        {workspace.data?.budgets.map((budget) => (
          <BudgetCard
            key={`${budget.provider}-${budget.limit}-${budget.unknownCalls}`}
            budget={budget}
            workspace={workspace}
          />
        ))}
      </div>
      <div className="budget-explanation">
        <ShieldCheck size={19} />
        <div>
          <strong>Reserved before a request starts.</strong>
          <p>
            With a limit enabled, Vizor verifies input tokens and holds the
            maximum estimated cost, including the output cap. Running requests
            share the available balance. Unknown prices or failed token counts
            block protected generations.
          </p>
          <p>
            Budgets use UTC calendar months and the app’s listed prices. They
            cover this workspace, not other apps or a provider’s entire bill.
            Interrupted requests keep a conservative charge when final usage is
            unavailable.
          </p>
        </div>
      </div>
      <section className="ledger-section">
        <div className="queue-toolbar">
          <h2>Recent request ledger</h2>
          <span>Latest 50 · all dates</span>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {!entries.length ? (
          <p className="muted">
            Requests will appear here after your first connection test or
            conversation.
          </p>
        ) : (
          <div className="ledger-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Request</th>
                  <th>Model</th>
                  <th>Accounted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {new Date(entry.createdAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>
                      {entry.source === "connection"
                        ? "Connection test"
                        : entry.source === "orchestrator"
                          ? "Orchestrator"
                          : entry.source === "adjustment"
                            ? "Opening balance"
                            : entry.source === "legacy"
                              ? "Earlier usage"
                              : "Agent chat"}
                    </td>
                    <td>{entry.model}</td>
                    <td>
                      {["unknown", "reconciled"].includes(entry.status) ||
                      (entry.charged == null && entry.quoted == null)
                        ? "Unavailable"
                        : entry.charged == null
                          ? `${currency(entry.quoted!)} reserved`
                          : currency(entry.charged)}
                      {entry.estimated && <small>Conservative estimate</small>}
                    </td>
                    <td>{entry.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
function BudgetCard({
  budget,
  workspace,
}: {
  budget: BudgetView;
  workspace: ReturnType<typeof useWorkspace>;
}) {
  const [enabled, setEnabled] = useState(budget.limit != null),
    [limit, setLimit] = useState(budget.limit?.toString() ?? ""),
    [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const exposure = budget.spent + budget.reserved,
    percent =
      budget.limit === 0
        ? 100
        : budget.limit == null
          ? 0
          : Math.min(100, (exposure / budget.limit) * 100);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`budgets/${budget.provider}`, "PATCH", {
        limit: enabled ? Number(limit) : null,
        ...(opening.trim() ? { openingBalance: Number(opening) } : {}),
      });
      await workspace.reload();
      workspace.setNotice(`${budget.label} spending settings saved.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`budget-card ${budget.blocked ? "blocked" : budget.warning ? "warning" : ""}`}
      aria-label={`${budget.label} spending limit`}
    >
      <div className="budget-card-header">
        <h2>{budget.label}</h2>
        <span>{budget.period} · UTC</span>
      </div>
      <div className="budget-amount">
        <strong>{currency(budget.spent)}</strong>
        <span>
          {budget.limit == null
            ? "No monthly cap"
            : `of ${currency(budget.limit)} monthly cap`}
        </span>
      </div>
      <progress
        value={percent}
        max={100}
        aria-label={`${budget.label} budget used or reserved`}
      />
      <div className="budget-reserved">
        <span>{currency(budget.reserved)} reserved</span>
        <span>
          {budget.limit == null
            ? "Optional protection"
            : `${percent.toFixed(0)}% used or reserved`}
        </span>
      </div>
      {budget.warning && (
        <div className="budget-warning" role="status">
          <AlertCircle size={15} />
          <span>
            {budget.blocked
              ? "New generations are blocked until balance is available or settings change."
              : "At least 80% of the monthly budget is used or reserved."}
          </span>
        </div>
      )}
      {budget.unknownCalls > 0 && (
        <p className="field-note warning">
          {budget.unknownCalls} unpriced or incomplete earlier requests need
          reconciliation before protected calls can run.
        </p>
      )}
      <form onSubmit={save}>
        <label className="budget-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enable monthly spending limit</span>
        </label>
        {enabled && (
          <label>
            Monthly limit (USD)
            <input
              type="number"
              min={0}
              max={1000000}
              step="0.01"
              required
              value={limit}
              placeholder="Choose your limit"
              onChange={(e) => setLimit(e.target.value)}
            />
            <small>A $0 limit pauses new generations on this provider.</small>
          </label>
        )}
        <details
          className="reconcile-details"
          open={budget.unknownCalls > 0 ? true : undefined}
        >
          <summary>Reconcile earlier usage</summary>
          <p>
            If earlier calls have unknown prices or you want to include spending
            outside Vizor, enter a conservative total spent so far from your
            provider account. This cannot lower the spend already recorded here.
          </p>
          <label>
            Opening balance (USD)
            <input
              type="number"
              min={Math.ceil(budget.spent * 100) / 100}
              max={1000000}
              step="0.01"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
            />
          </label>
        </details>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <Check size={14} />
          )}
          Save {budget.label} limit
        </button>
      </form>
      <p className="budget-models">
        Protected models: {budget.pricedModels.join(", ") || "None priced yet"}
      </p>
    </section>
  );
}
