import { useState } from "react";
import { postAction } from "../lib/actions.js";

interface ReviseDecisionButtonProps {
  decisionId: string;
  currentText: string;
  onRevised: () => void | Promise<void>;
}

/**
 * Inline editor that posts a `revise_decision` action. The overlay swaps
 * the displayed text on the next read; the underlying session body keeps
 * the original so the audit trail is intact. Submitting an empty string
 * reverts (overlay reducer deletes the entry).
 */
export function ReviseDecisionButton({ decisionId, currentText, onRevised }: ReviseDecisionButtonProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(currentText);

  const submit = async () => {
    const next = value.trim();
    if (!next || next === currentText) { setEditing(false); return; }
    setBusy(true);
    try {
      await postAction({
        kind: "revise_decision",
        subject_type: "decision",
        subject_id: decisionId,
        payload: { to: next, original_text: currentText },
      });
      await onRevised();
      setEditing(false);
    } catch {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button type="button" className="chip" onClick={() => { setValue(currentText); setEditing(true); }}>
        revise
      </button>
    );
  }

  return (
    <div className="promote-editor" onClick={(e) => e.stopPropagation()}>
      <input
        className="form-input form-input-inline promote-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
        disabled={busy}
        autoFocus
      />
      <button type="button" className="chip" onClick={() => void submit()} disabled={busy || !value.trim()}>save</button>
      <button type="button" className="chip" onClick={() => setEditing(false)} disabled={busy}>cancel</button>
    </div>
  );
}
