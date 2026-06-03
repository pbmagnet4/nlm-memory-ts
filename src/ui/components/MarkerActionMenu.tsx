import { useState } from "react";
import { postAction, type ActionPayload } from "../lib/actions.js";

interface InstantOption {
  readonly value: string;
  readonly label: string;
  readonly kind: "instant";
  readonly action: ActionPayload;
}

interface EditorOption {
  readonly value: string;
  readonly label: string;
  readonly kind: "editor";
  readonly buildAction: (text: string) => ActionPayload;
}

export type MarkerActionOption = InstantOption | EditorOption;

interface MarkerActionMenuProps {
  readonly options: ReadonlyArray<MarkerActionOption>;
  /** Initial text seeded into the editor when an editor option is picked. */
  readonly editorSeed: string;
  readonly onChanged: () => void | Promise<void>;
}

/**
 * Single dropdown that exposes every mutation on a marker row. Instant
 * options fire postAction immediately; editor options expand an inline
 * input. The select resets to its placeholder after each successful
 * action so the row stays neutral.
 */
export function MarkerActionMenu({ options, editorSeed, onChanged }: MarkerActionMenuProps) {
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<EditorOption | null>(null);
  const [draft, setDraft] = useState("");

  const reset = () => {
    setSelected("");
    setEditor(null);
    setDraft("");
  };

  const run = async (action: ActionPayload) => {
    setBusy(true);
    try {
      await postAction(action);
      await onChanged();
      reset();
    } catch {
      setBusy(false);
    }
  };

  const handleChange = (value: string) => {
    setSelected(value);
    const opt = options.find((o) => o.value === value);
    if (!opt) { reset(); return; }
    if (opt.kind === "instant") {
      void run(opt.action);
    } else {
      setEditor(opt);
      setDraft(editorSeed);
    }
  };

  const submitEditor = () => {
    if (!editor) return;
    const text = draft.trim();
    if (!text || text === editorSeed) { reset(); return; }
    void run(editor.buildAction(text));
  };

  if (editor) {
    return (
      <div className="marker-editor" onClick={(e) => e.stopPropagation()}>
        <input
          className="form-input form-input-inline marker-editor-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitEditor(); }
            if (e.key === "Escape") { e.preventDefault(); reset(); }
          }}
          disabled={busy}
          autoFocus
          aria-label={editor.label}
        />
        <button type="button" className="chip" onClick={submitEditor} disabled={busy || !draft.trim()}>save</button>
        <button type="button" className="chip" onClick={reset} disabled={busy}>cancel</button>
      </div>
    );
  }

  return (
    <select
      className="form-input form-input-inline marker-action-select"
      value={selected}
      disabled={busy}
      onChange={(e) => handleChange(e.target.value)}
      aria-label="Row actions"
    >
      <option value="">actions…</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
