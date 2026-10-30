"use client";
import { useState } from "react";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import type { ProviderInfo } from "@/lib/types";
import { api } from "./use-workspace";
import { Dialog, ProviderGlyph } from "./ui";
export function ProviderSettings({
  providers,
  onChange,
  openWorkspace,
  onError,
}: {
  providers: ProviderInfo[];
  onChange: () => Promise<unknown>;
  openWorkspace: () => Promise<void>;
  onError: (value: string) => void;
}) {
  return (
    <div className="onboarding provider-settings">
      <div className="page-eyebrow">
        <span className="eyebrow-line" />
        {providers.some((p) => p.connected)
          ? "YOUR PROVIDERS"
          : "LET’S GET YOU SET UP"}
      </div>
      <h1>
        {providers.some((p) => p.connected)
          ? "API connections"
          : "Connect your API"}
      </h1>
      <p className="page-intro">
        Connect Anthropic or OpenAI for the orchestrator and API chat agents.
        API usage is billed separately from subscriptions. Claude Code and Codex
        terminal agents sign in inside their own tools.
      </p>
      <div className="provider-cards">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onChange={onChange}
            onError={onError}
          />
        ))}
      </div>
      {providers.some((p) => p.connected) && (
        <button
          className="primary open-workspace"
          onClick={() => void openWorkspace()}
        >
          Open workspace
          <ArrowRight size={16} />
        </button>
      )}
      <div className="onboarding-footer">
        <span>
          <ShieldCheck size={14} /> Keys are encrypted on this computer. Only
          their last four characters are returned.
        </span>
        <span>No telemetry. No extra service.</span>
      </div>
    </div>
  );
}
function ProviderCard({
  provider,
  onChange,
  onError,
}: {
  provider: ProviderInfo;
  onChange: () => Promise<unknown>;
  onError: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replace, setReplace] = useState(false);
  const [remove, setRemove] = useState(false);
  async function test(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError("");
    try {
      await api(`providers/${provider.id}`, "POST", { key: value });
      setValue("");
      setReplace(false);
      await onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setValue("");
      setBusy(false);
    }
  }
  return (
    <section
      className={`connection-card provider-card ${provider.id}`}
      data-provider={provider.id}
      aria-label={`${provider.company} connection`}
    >
      <div className="connection-top">
        <span className={`claude-logo ${provider.id}`}>
          <ProviderGlyph id={provider.id} size={30} />
        </span>
        <span
          className={`connection-badge ${provider.connected ? "connected" : ""}`}
        >
          <span className="tiny-dot" />
          {provider.connected ? "Connected" : "Ready to connect"}
        </span>
      </div>
      <h2>{provider.label}</h2>
      <p className="provider-subtitle">by {provider.company}</p>
      <p className="connection-description">
        {provider.id === "anthropic"
          ? "Use Claude models with your Anthropic API credits. Choose a model for each API agent or the orchestrator."
          : "Use OpenAI models with your OpenAI API balance. Choose a model for each API agent or the orchestrator."}
      </p>
      {provider.connected && !replace ? (
        <>
          <div className="saved-key">
            <KeyRound size={16} />
            <span>•••• •••• •••• {provider.last4}</span>
            <button className="text-button" onClick={() => setReplace(true)}>
              Replace
            </button>
          </div>
          <button
            className="danger-text provider-remove"
            onClick={() => setRemove(true)}
          >
            Remove key
          </button>
        </>
      ) : (
        <form className="key-form" onSubmit={test}>
          <label htmlFor={`key-${provider.id}`}>
            {replace ? "New" : "Your"} {provider.company} API key
          </label>
          <div className="key-input">
            <KeyRound size={16} />
            <input
              id={`key-${provider.id}`}
              type={show ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`${provider.keyPrefix}…`}
              autoComplete="off"
              maxLength={512}
              required
              spellCheck={false}
              disabled={busy}
            />
            <button
              className="icon-button"
              type="button"
              aria-label={`${show ? "Hide" : "Show"} ${provider.company} API key`}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button className="primary" disabled={busy || !value.trim()}>
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} />
                Testing connection…
              </>
            ) : (
              <>
                Test connection
                <ArrowRight size={16} />
              </>
            )}
          </button>
          {replace && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setReplace(false);
                setValue("");
              }}
            >
              Cancel replacement
            </button>
          )}
        </form>
      )}
      <details className="provider-instructions">
        <summary>How to get an API key</summary>
        <ol>
          {provider.keyInstructions.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a href={provider.consoleUrl} target="_blank" rel="noreferrer">
          Open {provider.company} console ↗
        </a>
      </details>
      <div className="billing-note">
        <span className="note-icon">i</span>
        <p>
          API usage is billed by {provider.company}, separately from{" "}
          {provider.subscription}. Testing makes a small, capped API call and
          can incur a charge.
        </p>
      </div>
      {remove && (
        <Dialog
          title={`Remove ${provider.label} key?`}
          onClose={() => setRemove(false)}
        >
          <p>
            The saved key will be deleted and this provider’s current responses
            will stop. Other providers and your conversations stay available.
          </p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setRemove(false)}>
              Keep key
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`providers/${provider.id}`, "DELETE");
                  setRemove(false);
                  await onChange();
                } catch (e) {
                  onError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove key
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
