# nle-memory desktop product — phased plan

**Goal.** Ship nle-memory as a local-first desktop app others can install and use. Single-user-per-instance. SQLite on the user's disk. No SaaS infra, no auth, no multi-tenancy.

**Why desktop.** Privacy story is the product (transcripts never leave the machine). Sidesteps the entire SaaS infra tax (hosting, billing, auth, compliance). Architecture leaves a multi-tenant door open if we ever want it.

**Stack decision.** Tauri 2 wrapper around the existing Node daemon + Vite UI. Rust shell is ~3MB; bundles the daemon as a sidecar binary. Cross-platform (mac/windows/linux) from one codebase. Auto-update via Tauri's built-in updater. Alternative was Electron — rejected on bundle size (100MB+) and resource footprint.

**Out of scope for v1.** Multi-tenant, cloud sync, mobile, fact extraction UI, RAG over transcripts, agent marketplace.

---

## Phase 0 — Architecture changes (no UI yet)

Required before the UI can be config-driven. Backend-only.

1. **Sources registry.** New `sources` table: `id, kind, name, path_or_url, runtime_label, parse_config (json), enabled, created_at`. Migrate existing adapter detection to seed three default rows (`claude-code`, `hermes`, `pi`) on first boot of an empty DB.
2. **Generic JSONL adapter.** One `TranscriptAdapter` implementation that reads any directory of JSONL files using `parse_config` for field mapping. The three existing adapters become preset configs for this generic adapter.
3. **Providers registry.** New `providers` table: `id, kind, name, api_key_ref, base_url, default_model, enabled`. API keys stored in the OS keychain via Tauri's `keyring` plugin (not in SQLite). Migrate the current DeepSeek/Ollama wiring to seed default rows.
4. **Live model discovery.** Provider interface gains `listModels()`. Ollama hits `/api/tags`; OpenAI/Anthropic/OpenRouter hit `/v1/models`; DeepSeek stays hardcoded.
5. **Webhook ingest.** `POST /api/ingest` with a body conforming to the canonical session shape. Token-gated via a token stored in user prefs.

**Deliverables.** Migrations, new tables, generic adapter, provider abstraction, ingest endpoint, tests. No UI changes yet.

## Phase 1 — Settings UI for sources + providers

The configuration surface. Existing Settings pages get extended.

1. **Sources page** — list configured sources with status (enabled / last scanned / session count). "Add source" opens a wizard: pick preset (Claude Code / Hermes / pi.dev / Custom JSONL / Webhook). Preset auto-fills paths and parse config; user can override. Custom JSONL is a directory picker + field-mapping form.
2. **Providers page** — list configured providers with status (key present / last used / model count). "Add provider" picks kind (DeepSeek / Ollama / OpenAI / Anthropic / OpenRouter / Custom OpenAI-compatible), then prompts for key + base URL. "Test connection" button hits `listModels()` and shows results.
3. **Classifier page rewrite** — Provider/Model dropdowns now populate from configured providers, not hardcoded constants. The free-text Model fallback stays.

**Deliverables.** Two new settings pages (or one expanded), provider/source CRUD endpoints, connection-test endpoint.

## Phase 2 — Tauri shell + first-run experience

Make it installable.

1. **Tauri wrapper.** Bundle the Node daemon as a sidecar process. Tauri shell loads the UI at `localhost:3940/ui` in a webview. Auto-start daemon on app launch, auto-stop on quit.
2. **First-run wizard.** If `sources` table is empty: full-screen wizard. Step 1: detect presets ("We found Claude Code at ~/.claude/projects/ — enable?"). Step 2: pick a provider (skip if you only want recall + UI without ingest). Step 3: done.
3. **Auto-updater.** Tauri updater wired to a GitHub releases feed. Signed builds.
4. **Installer artifacts.** `.dmg` (mac, notarized), `.msi` (windows, signed), `.deb` + `.AppImage` (linux). CI on tag push.

**Deliverables.** Tauri project, sidecar wiring, wizard UI, signed installers in GitHub Releases.

## Phase 3 — Polish for public release

Things you can ship without, but probably shouldn't.

1. **Onboarding telemetry** — opt-in, anonymous: "user got past first-run wizard, has N sources, K providers." Helps you find the install funnel that bleeds the most users.
2. **Backup + restore** — one-click SQLite export. Restore from a `.nle-backup` file.
3. **Open-source license + landing page** — pick a license (MIT or AGPL — different go-to-markets), throw up a site, write the README that explains what nle-memory is in <60s.
4. **First 5 users.** Manual recruit. Watch each one install. Fix what breaks.

**Deliverables.** Telemetry endpoint, backup CLI + UI button, public repo, landing page, install support for 5 users.

---

## Open questions to resolve before Phase 0

These are blockers; rest of the plan flexes around the answers.

1. **License.** MIT (anyone can fork, including commercial competitors) vs AGPL (cloud forks must open-source their changes). If you ever plan to host a SaaS version yourself, AGPL is the safer moat.
2. **Distribution.** Ship as `.dmg`/`.msi` on GitHub Releases (free, technical audience) vs Mac App Store + Microsoft Store (broader reach, but they review every build and Apple takes 30%).
3. **Branding.** Is this called "nle-memory"? It's a great internal name but not a great consumer one. "NLE" doesn't mean anything to someone who hasn't read the architecture doc.
4. **Pricing model later.** Free + open source forever? Free desktop + paid cloud sync? Paid desktop ($X one-time)? Doesn't block Phase 0–1, but it shapes the Phase 3 landing page and license decision.
