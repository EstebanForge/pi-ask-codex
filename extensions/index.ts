/**
 * AskCodex — delegate a self-contained sub-task to OpenAI's Codex CLI.
 * The AskClaude-style delegation pattern, pointed at GPT via `codex exec`.
 *
 * One self-contained tool. Spawns `codex exec --json`, parses the JSONL event
 * stream for structured progress + the final agent message, and returns it.
 * Codex runs its OWN tool loop (read, write, edit, exec) inside the workspace.
 *
 * Model aliases: friendly names resolve to whatever Codex currently advertises
 * via `codex debug models --bundled`. No version strings are hardcoded — the
 * catalog is fetched once at extension load and the highest version wins.
 *   "default"        -> omit --model (Codex's own default)
 *   "mini" / "nano"  -> highest-version mini family
 *   "full" / "gpt"   -> highest-version main family
 *   "5.6 mini"       -> pinned version + family
 *   "gpt-5.4-mini"   -> exact passthrough (verifies against catalog; falls
 *                       through to codex verbatim if discovery is unavailable)
 *
 * Config: ~/.pi/agent/ask-codex.json (global) merged over
 *         .pi/ask-codex.json (project). Editable via /codex.
 *
 * Two modes (agent decides per call):
 *   - omit sessionId    -> one-shot, Codex starts fresh
 *   - pass sessionId     -> resume that Codex session (full context)
 * The id is read directly from the `thread.started` JSON event (Codex prints
 * it; no snapshot/diff needed). Continuation uses `codex exec resume <id>`.
 *
 * Env:  CODEX_BIN (binary path), CODEX_EXTRA_ARGS (extra args; the value is
 *       parsed with a shell-like splitter so quoted args with spaces work).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getSettingsListTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// --- Constants -------------------------------------------------------------

const DEFAULT_TIMEOUT_MIN = 10;
const GRACE_AFTER_TIMEOUT_MS = 5000;
const STATUS_INTERVAL_MS = 1000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "ask-codex.json");

const DEFAULT_MODEL = "default";
const DEFAULT_REASONING = "medium";
const DEFAULT_SANDBOX = "workspace-write";

// codex session/thread ids are UUIDs (e.g. "0199a213-81c0-7800-8aa1-bbab2a035a53").
// Anchored to UUID shape so a leading-dash value (e.g.
// "--dangerously-bypass-approvals-and-sandbox") can NEVER pass and misbind
// on codex's arg parser as the token after the resume session-id positional
// — which would silently disable the sandbox. The dash-tolerant variant
// (`[A-Za-z0-9-]`) was a security regression; this is the fix.
const SESSION_ID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CODEX_DESCRIPTION = `Delegate a self-contained sub-task to OpenAI Codex. This tool answers to three equivalent names the user may use interchangeably: **codex**, **openai**, and **gpt**. When the user says "ask codex", "ask openai", "ask gpt", or otherwise refers to any of these, call THIS tool. Codex runs its OWN tool loop: it can read, write, edit, and execute inside the workspace, then returns its final answer. Use for a second opinion from a different model family, GPT-specific reasoning, or isolated sub-tasks you do not need to drive step-by-step. Provide a complete, self-contained task description; Codex will not see this conversation.

TWO MODES (you choose):
- **One-shot (isolated)**: omit sessionId. Codex starts fresh with no memory of prior calls. Use for independent questions.
- **Continued conversation**: pass the sessionId returned in the PREVIOUS call's details (details.sessionId). Codex resumes that session with full context intact — use for follow-ups, multi-turn refinement, or when the user says "ask codex to follow up / continue / now do X based on what you just did". Thread the id from each result into the next call.`;

// --- Types -----------------------------------------------------------------

type ReasoningEffort = "minimal" | "low" | "medium" | "high";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

interface Config {
	defaultModel: string;
	defaultReasoning: ReasoningEffort;
	defaultSandbox: SandboxMode;
}

// Minimal shapes for the JSONL events we actually consume. Unknown fields
// are ignored. See: https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/
interface CodexEvent {
	type: string;
	thread_id?: string;
	message?: string;
	error?: { message?: string };
	usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
	item?: {
		id: string;
		type: string;
		text?: string;
		command?: string;
		status?: string;
		exit_code?: number | null;
		changes?: Array<{ path: string; kind: string }>;
		query?: string;
	};
}

// --- Config ----------------------------------------------------------------

function projectConfigPath(): string {
	return path.join(process.cwd(), ".pi", "ask-codex.json");
}

function tryReadJson(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const REASONING_VALUES: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const SANDBOX_VALUES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

function isReasoningEffort(v: unknown): v is ReasoningEffort {
	return typeof v === "string" && (REASONING_VALUES as string[]).includes(v);
}
function isSandboxMode(v: unknown): v is SandboxMode {
	return typeof v === "string" && (SANDBOX_VALUES as string[]).includes(v);
}

function loadConfig(): Config {
	const global = tryReadJson(GLOBAL_CONFIG_PATH);
	const project = tryReadJson(projectConfigPath());
	const merged = { ...global, ...project };

	const reasoningRaw = String(merged.defaultReasoning ?? DEFAULT_REASONING).toLowerCase();
	const reasoning: ReasoningEffort = isReasoningEffort(reasoningRaw) ? reasoningRaw : DEFAULT_REASONING;

	const sandboxRaw = String(merged.defaultSandbox ?? DEFAULT_SANDBOX).toLowerCase();
	const sandbox: SandboxMode = isSandboxMode(sandboxRaw) ? sandboxRaw : DEFAULT_SANDBOX;

	return {
		defaultModel: String(merged.defaultModel ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
		defaultReasoning: reasoning,
		defaultSandbox: sandbox,
	};
}

interface SaveResult {
	path: string;
	/** True when the write went to the project config (project shadows global). */
	routedToProject: boolean;
}

/** Persist a config patch. If the project config already defines any patched
 *  key, write to the PROJECT file so the change actually takes effect
 *  (project shadows global on load); otherwise write to global.
 *  Atomic: temp file + rename, with temp cleanup on failure.
 *  Routing is all-or-nothing per save: if ANY patched key is shadowed by
 *  project config, the WHOLE patch goes to project (a previously-global key
 *  is silently promoted to project-scoped). Acceptable: the slash command
 *  saves all three keys together, and mixing scopes in one save would surprise
 *  more than this does. */
function saveConfig(patch: Partial<Config>): SaveResult {
	const projectRaw = tryReadJson(projectConfigPath());
	const projectShadows = Object.keys(patch).some((k) => k in projectRaw);
	const targetPath = projectShadows ? projectConfigPath() : GLOBAL_CONFIG_PATH;

	const existing = tryReadJson(targetPath);
	const next = { ...existing, ...patch };
	const dir = path.dirname(targetPath);
	fs.mkdirSync(dir, { recursive: true });

	const tmp = `${targetPath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
		fs.renameSync(tmp, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw err;
	}
	return { path: targetPath, routedToProject: projectShadows };
}

// --- Model discovery + alias resolution ------------------------------------

// Codex slug taxonomy (verified against `codex debug models --bundled`):
//   gpt-X.Y           -> "main" family (flagship / balanced)
//   gpt-X.Y-mini      -> "mini" family (fast / cheap)
//   gpt-X.Y-nano      -> "mini" family (smaller / cheaper)
//   gpt-X.Y-pro       -> "pro" family (deep reasoning)
//   gpt-X.Y-codex     -> "codex" family (legacy coding-tuned naming)
//   gpt-X.Y-{sol,terra,luna} -> "main" family variants (current GPT-5.6 naming)
// Anything else (e.g. "codex-auto-review") is excluded from resolution.
type Family = "main" | "mini" | "pro" | "codex" | "other";

interface CodexModelEntry {
	full: string; // exact slug, e.g. "gpt-5.6-sol"
	family: Family;
	version: string | null; // "5.6" or null if unparseable
}

/** Descending numeric version compare. "5.10" > "5.9" (lexical sort would
 *  wrongly rank "5.9" higher because '9' > '1'). */
function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return db - da; // descending
	}
	return 0;
}

/** Map one `codex debug models --bundled` slug to a (family, version) pair.
 *  Unknown shapes (e.g. "codex-auto-review") land in "other" and are
 *  excluded from alias resolution but still valid as exact --model args.
 *
 *  NOTE: the regex captures the suffix as a single token. Compound variants
 *  like `gpt-5.6-mini-pro` are not handled — they fall to "other" and remain
 *  exact-only. If OpenAI introduces compound naming, extend the literal
 *  suffix checks below rather than the regex. */
function classifySlug(slug: string): { family: Family; version: string | null } {
	const m = slug.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i);
	if (!m) return { family: "other", version: null };
	const version = m[1];
	const suffix = m[2];
	if (!suffix) return { family: "main", version };
	const lower = suffix.toLowerCase();
	if (lower === "mini" || lower === "nano") return { family: "mini", version };
	if (lower === "pro") return { family: "pro", version };
	if (lower === "codex" || lower.startsWith("codex-")) return { family: "codex", version };
	// GPT-5.6 variant naming (sol/terra/luna) is main-family. sol is the
	// flagship, terra balanced, luna fast — distinguished in resolveModel
	// via MAIN_VARIANT_PRIORITY so ties break deterministically.
	if (lower === "sol" || lower === "terra" || lower === "luna") return { family: "main", version };
	return { family: "other", version };
}

/** Tiebreak priority within the main family at the same version.
 *  sol (flagship) > plain gpt-X.Y (legacy naming) > terra (balanced) >
 *  luna (fast) > anything else. Catalog JSON order from
 *  `codex debug models --bundled` is not part of the contract, so an
 *  explicit priority is required for deterministic flagship selection. */
const MAIN_VARIANT_PRIORITY: Record<string, number> = {
	sol: 0,
	"": 1, // plain gpt-X.Y (no suffix)
	terra: 2,
	luna: 3,
};
function mainVariantRank(slug: string): number {
	const m = slug.match(/^gpt-\d+(?:\.\d+)?(?:-(.+))?$/i);
	if (!m) return 99;
	const suffix = (m[1] ?? "").toLowerCase();
	return MAIN_VARIANT_PRIORITY[suffix] ?? 99;
}

/** Pull the raw model catalog via `codex debug models --bundled` and parse
 *  it into structured entries. Returns [] on any failure (non-fatal): the
 *  caller falls back to passthrough so exact slugs typed by the user still
 *  reach codex verbatim. */
async function discoverCodexModels(binary: string): Promise<CodexModelEntry[]> {
	let text = "";
	try {
		text = await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["debug", "models", "--bundled"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => (out += d));
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
	} catch {
		return [];
	}
	if (!text.trim()) return [];

	// Each entry carries a large `base_instructions` blob (~50KB). Parse the
	// whole thing but read only the fields we need; entries are huge but
	// JSON.parse handles multi-MB fine.
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const models = (parsed as { models?: unknown }).models;
	if (!Array.isArray(models)) return [];

	const entries: CodexModelEntry[] = [];
	for (const m of models) {
		const slug = (m as { slug?: unknown }).slug;
		if (typeof slug !== "string" || !slug) continue;
		const { family, version } = classifySlug(slug);
		entries.push({ full: slug, family, version });
	}
	return entries;
}

/** Resolve a friendly alias / partial name to an exact --model value. Mirrors
 *  the antigravity ext's version-sort pattern: aliases pick the highest
 *  version of the named family; pinned versions (e.g. "5.6 mini") select a
 *  specific version. Exact slugs pass through. Returns null to omit --model
 *  entirely (Codex's own default). */
function resolveModel(
	input: string,
	entries: CodexModelEntry[],
): { flagValue: string | null } {
	const lower = input.toLowerCase().trim();
	if (lower === "default" || lower === "") return { flagValue: null };

	// 1. Exact slug match against the live catalog.
	const exact = entries.find((e) => e.full.toLowerCase() === lower);
	if (exact) return { flagValue: exact.full };

	// 2. Parse the alias into family + optional version. Match the family
	//    keyword as a standalone token (\b) so pinned forms like "5.6 mini"
//    / "5.4 full" resolve, but compound slugs that happen to contain
	//    "gpt" or "pro" don't false-match. The exact-slug match above runs
	//    first, so a full slug like "gpt-5.4-mini" never reaches this
	//    branch as a family parse. Check specific families (mini/codex/pro)
//    before the generic "full" / "gpt" so a "gpt-...-mini" intent routes
//    to mini.
	let family: Family | null = null;
	if (/\b(mini|nano)\b/.test(lower)) family = "mini";
	else if (/\bcodex\b/.test(lower)) family = "codex";
	else if (/\bpro\b/.test(lower)) family = "pro";
	else if (/\b(full|gpt)\b/.test(lower)) family = "main";

	// Unknown alias (e.g. a bare version like "5.6") or unparseable input —
	// passthrough to codex and let it decide. Exact user-typed slugs and
	// API-key-only model ids keep working this way even when discovery fails.
	if (family === null) return { flagValue: input };

	const versionMatch = lower.match(/(\d+(?:\.\d+)?)/);
	const pinnedVersion = versionMatch ? versionMatch[1] : null;

	// 3. Filter by family.
	let candidates = entries.filter((e) => e.family === family);
	if (candidates.length === 0) {
		// Family not in the catalog (e.g. no pro models this release) —
		// passthrough rather than fabricating.
		return { flagValue: input };
	}

	// 4. Pin version if specified; otherwise pick the highest version
	//    (numeric compare, not lexical — see compareVersionsDesc). Within a
	//    version tie, break by family-specific variant priority so flagship
	//    selection is deterministic regardless of catalog array order.
	if (pinnedVersion) {
		const versioned = candidates.filter((e) => e.version === pinnedVersion);
		if (versioned.length === 0) {
			// Pinned version not present in catalog — passthrough so the user's
			// explicit choice reaches codex even if the version is stale.
			return { flagValue: input };
		}
		versioned.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
		return { flagValue: versioned[0].full };
	}
	const versions = candidates
		.map((e) => e.version)
		.filter((v): v is string => v !== null);
	if (versions.length === 0) {
		candidates.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
		return { flagValue: candidates[0].full };
	}
	const uniqueVersions = [...new Set(versions)].sort(compareVersionsDesc);
	const top = uniqueVersions[0];
	const topCandidates = candidates
		.filter((e) => e.version === top)
		.sort((a, b) => mainVariantRank(a.full) - mainVariantRank(b.full));
	return { flagValue: topCandidates[0].full };
}

// --- Status rendering (the useful ideas borrowed from pi-codex) -------------

/** True for commands whose output validates the work (test/lint/build/etc).
 *  Used to label progress as "verifying" rather than just "running". */
function looksLikeVerificationCommand(command: string): boolean {
	return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
		command,
	);
}

function shorten(text: string, limit = 96): string {
	const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
	if (!normalized) return "";
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, limit - 3)}...`;
}

/** Map an item.started/item.completed event to a short human status line.
 *  Returns null for item types we don't surface (keeps status lean). */
function describeItem(event: CodexEvent, lifecycle: "started" | "completed"): string | null {
	const item = event.item;
	if (!item) return null;
	switch (item.type) {
		case "agent_message":
			// Only the completed agent_message is the answer; surfaced separately
			// as the final result, not as a running status line.
			return null;
		case "reasoning":
			return lifecycle === "completed" && item.text
				? `thinking: ${shorten(item.text)}`
				: null;
		case "command_execution":
			if (lifecycle === "started") {
				const verb = looksLikeVerificationCommand(item.command ?? "")
					? "verifying"
					: "running";
				return `${verb}: ${shorten(item.command ?? "")}`;
			}
			return `command ${item.status ?? "done"}: ${shorten(item.command ?? "")} (exit ${item.exit_code ?? "?"})`;
		case "file_change": {
			const paths = (item.changes ?? []).map((c) => c.path);
			if (paths.length === 0) return null;
			const verb = lifecycle === "started" ? "editing" : "edited";
			return `${verb}: ${shorten(paths.join(", "), 140)}`;
		}
		case "mcp_tool_call":
			return lifecycle === "started"
				? `tool: ${item.id}`
				: `tool ${item.status ?? "done"}`;
		case "web_search":
			return lifecycle === "completed" ? `searched: ${shorten(item.query ?? "")}` : null;
		case "todo_list":
			return lifecycle === "completed" ? "plan updated" : null;
		default:
			return null;
	}
}

// --- codex process helpers -------------------------------------------------

function resolveCodex(): string {
	return process.env.CODEX_BIN || "codex";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shell-like argument splitter for CODEX_EXTRA_ARGS: respects "..." and '...'
 *  quoted segments so a value with spaces stays one arg. Bare tokens split on
 *  whitespace. NOTE: backslash escapes are NOT unescaped — a literal `\"`
 *  inside a quoted segment stays in the arg. CODEX_EXTRA_ARGS is trusted env
 *  set by the user, so this is cosmetic, not a security issue. */
function splitArgs(raw: string): string[] {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return [];
	const parts: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(trimmed)) !== null) {
		parts.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return parts;
}

function extraArgs(): string[] {
	const raw = process.env.CODEX_EXTRA_ARGS;
	return raw ? splitArgs(raw) : [];
}

/** Best-effort version check: `codex --version` exits 0 and prints a version
 *  string. Used to fail fast with a clear message instead of an opaque spawn
 *  error inside the tool call. */
async function codexAvailable(binary: string): Promise<boolean> {
	try {
		const out = await new Promise<string>((resolve, reject) => {
			const proc = spawn(binary, ["--version"], {
				stdio: ["ignore", "pipe", "ignore"],
				shell: false,
			});
			proc.stdout?.setEncoding("utf8");
			let out = "";
			let done = false;
			const finish = (v: string) => {
				if (done) return;
				done = true;
				clearTimeout(watchdog);
				resolve(v);
			};
			proc.stdout?.on("data", (d: string) => (out += d));
			proc.on("error", (err) => {
				clearTimeout(watchdog);
				reject(err);
			});
			proc.on("close", (code) => finish(code === 0 ? out : ""));
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
				finish("");
			}, DISCOVERY_TIMEOUT_MS);
		});
		return /codex/i.test(out);
	} catch {
		return false;
	}
}

// --- Extension -------------------------------------------------------------

interface CodexDetails {
	model: string | null;
	resolvedModel: string | null;
	sessionId: string | null;
	exitCode: number;
	aborted: boolean;
	timedOut: boolean;
	durationMs: number;
	usage: { inputTokens: number; outputTokens: number; reasoningTokens: number } | null;
	stderr: string;
}

function emptyDetails(model: string | null, resolvedModel: string | null): CodexDetails {
	return {
		model,
		resolvedModel,
		sessionId: null,
		exitCode: 0,
		aborted: false,
		timedOut: false,
		durationMs: 0,
		usage: null,
		stderr: "",
	};
}

export default async function (pi: ExtensionAPI) {
	const binary = resolveCodex();
	// Run both discovery probes in parallel: each carries its own 8s
	// watchdog, so worst-case load time is 8s instead of 16s. Either
	// failure is non-fatal (the other still completes).
	const [available, discovered] = await Promise.all([
		codexAvailable(binary).catch(() => false),
		discoverCodexModels(binary).catch(() => []),
	]);

	// --- /codex: view / change defaults -----------------------------------

	const MODEL_OPTIONS = ["default", "mini", "full"];
	const REASONING_OPTIONS: ReasoningEffort[] = REASONING_VALUES;
	const SANDBOX_OPTIONS: SandboxMode[] = SANDBOX_VALUES;

	pi.registerCommand("codex", {
		description: "AskCodex config: show status, or open the model/effort/sandbox picker. Usage: /codex",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			// Headless / RPC fallback: print a status snapshot.
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					[
						`AskCodex config`,
						`  codex available:  ${available ? "yes" : "NO (check PATH / CODEX_BIN)"}`,
						`  defaultModel:     ${config.defaultModel}`,
						`  resolved:         ${resolveModel(config.defaultModel, discovered).flagValue ?? "(codex default)"}`,
						`  catalog:          ${discovered.length} model(s) discovered`,
						`  defaultReasoning: ${config.defaultReasoning}`,
						`  defaultSandbox:   ${config.defaultSandbox}`,
						``,
						`Edit: ~/.pi/agent/ask-codex.json`,
					].join("\n"),
					"info",
				);
				return;
			}

			const items: SettingItem[] = [
				{
					id: "defaultModel",
					label: "Default model",
					description:
						"Friendly alias resolved at runtime via `codex debug models --bundled`. 'default' = omit the flag (Codex's own default); 'mini' = highest-version mini family; 'full' = highest-version main family. No version strings are hardcoded — pick whichever is current.",
					currentValue: config.defaultModel,
					values: MODEL_OPTIONS,
				},
				{
					id: "defaultReasoning",
					label: "Default reasoning effort",
					description:
						"Reasoning effort passed via -c model_reasoning_effort. Lower = faster and cheaper; higher = more thorough. 'medium' is a good default.",
					currentValue: config.defaultReasoning,
					values: REASONING_OPTIONS,
				},
				{
					id: "defaultSandbox",
					label: "Default sandbox",
					description:
						"Codex sandbox policy. 'workspace-write' (default) lets Codex edit files; 'read-only' for inspection only; 'danger-full-access' unrestricted.",
					currentValue: config.defaultSandbox,
					values: SANDBOX_OPTIONS,
				},
			];

			const pending: Partial<Config> = {};

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(
					new Text(theme.fg("accent", theme.bold("AskCodex defaults")), 1, 1),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 4, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (id === "defaultModel") {
							pending.defaultModel = newValue;
						} else if (id === "defaultReasoning") {
							if (isReasoningEffort(newValue)) pending.defaultReasoning = newValue;
						} else if (id === "defaultSandbox") {
							if (isSandboxMode(newValue)) pending.defaultSandbox = newValue;
						}
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});

			if (Object.keys(pending).length === 0) return;

			try {
				const result = saveConfig(pending);
				const changed = Object.entries(pending)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				const where = result.routedToProject
					? "(written to project .pi/ask-codex.json — it shadows global)"
					: "";
				ctx.ui.notify(`Saved: ${changed}${where ? ` ${where}` : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to save config: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// --- Tool registration -------------------------------------------------

	// Free string, not a StringEnum: aliases (default/mini/full/gpt/nano/pro/codex)
	// resolve via the catalog at load, but arbitrary exact slugs still pass through
	// so API-key-authenticated users can target any model codex supports. A
	// bounded enum would make that passthrough branch dead code.
	const modelParam = Type.Optional(
		Type.String({
			description:
				"Model alias or exact id. Friendly: 'default' (omit flag, codex picks), 'mini' (highest-version mini family), 'full' / 'gpt' (highest-version main family). Pin a version: '5.6 mini', '5.4 full'. Exact slugs pass through verbatim (e.g. 'gpt-5.6-sol', or any model your auth allows). Omit for the configured default.",
		}),
	);

	pi.registerTool({
		name: "AskCodex",
		label: "Ask Codex",
		description: CODEX_DESCRIPTION,
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Self-contained task for Codex. Include all context Codex needs; it cannot see this conversation.",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Absolute workspace path Codex runs in. Defaults to the current project root.",
				}),
			),
			model: modelParam,
			reasoningEffort: Type.Optional(
				StringEnum(REASONING_VALUES, {
					description:
						"Reasoning effort: 'minimal'/'low' (fast, cheap) through 'high' (thorough). Overrides the configured default. Lowering this is the primary lever for speed/cost.",
				}),
			),
			sandbox: Type.Optional(
				StringEnum(SANDBOX_VALUES, {
					description:
						"Sandbox policy: 'read-only' (inspect, no writes), 'workspace-write' (edit files in cwd, default), 'danger-full-access' (unrestricted). Overrides the configured default.",
				}),
			),
			sessionId: Type.Optional(
				Type.String({
					description:
						"Omit for a one-shot (Codex starts fresh). To CONTINUE a previous Codex session with its context intact, pass the sessionId returned in that call's details. Codex resumes that session.",
				}),
			),
			timeoutMinutes: Type.Optional(
				Type.Number({
					description: `Hard cap on the Codex run in minutes. Default ${DEFAULT_TIMEOUT_MIN}.`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Circular-delegation guard (best-effort). This extension registers
			// NO provider, so the check only fires if a future codex-as-provider
			// extension registers a provider literally named codex/openai.
			if (ctx.model?.provider === "codex" || ctx.model?.provider === "openai") {
				return {
					content: [
						{
							type: "text",
							text: "Error: AskCodex cannot be used when the active provider is already codex/OpenAI — you're already running through it.",
						},
					],
					details: {
						...emptyDetails(null, null),
						stderr: "circular delegation blocked",
					},
				};
			}

			if (!available) {
				return {
					content: [
						{
							type: "text",
							text: `Error: codex CLI not found at "${binary}". Install it (npm install -g @openai/codex) or set CODEX_BIN to its path.`,
						},
					],
					details: emptyDetails(null, null),
				};
			}

			const config = loadConfig();
			const requestedModel = (params.model as string | undefined) ?? config.defaultModel;
			// Defensive: reject leading-dash model values that could misbind
			// on codex's arg parser when spliced as the `-m` value. Same
			// threat model as SESSION_ID_RE — a leading-dash value can't be a
			// model id, so refuse it instead of letting it reach argv.
			if (typeof params.model === "string" && params.model.trim().startsWith("-")) {
				return {
					content: [
						{
							type: "text",
							text: `model value "${params.model}" starts with "-" — not a valid model id. Use a friendly alias (e.g. "full", "mini", "gpt") or a known slug (e.g. "gpt-5.5").`,
						},
					],
					details: emptyDetails(requestedModel, null),
				};
			}
			const resolved = resolveModel(requestedModel, discovered);
			const reasoning = isReasoningEffort(params.reasoningEffort)
				? params.reasoningEffort
				: config.defaultReasoning;
			const sandbox = isSandboxMode(params.sandbox) ? params.sandbox : config.defaultSandbox;

			const start = Date.now();
			const cwd = params.cwd || ctx.cwd || process.cwd();

			// Validate cwd up front for a clearer error than codex's.
			try {
				const stat = fs.statSync(cwd);
				if (!stat.isDirectory()) {
					return {
						content: [{ type: "text", text: `cwd is not a directory: ${cwd}` }],
						details: emptyDetails(requestedModel, resolved.flagValue),
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `cwd does not exist: ${cwd}` }],
					details: emptyDetails(requestedModel, resolved.flagValue),
				};
			}

			const timeoutMin = params.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;

			// Continuity: validate sessionId (Codex ids are UUIDs) before
			// threading it into the resume positional. A leading-dash value
			// could misbind on codex's arg parser.
			const rawSessionId = params.sessionId;
			const isContinuation =
				typeof rawSessionId === "string" &&
				rawSessionId.length > 0 &&
				SESSION_ID_RE.test(rawSessionId);

			// Build argv. `codex exec [--json] [opts] "<prompt>"` for fresh,
			// `codex exec resume [opts] <sessionId> "<prompt>"` for continued.
			// stdin is closed (<ignore>) so codex never blocks waiting for a tty.
			const args: string[] = ["exec"];
			if (isContinuation) args.push("resume");
			args.push("--json", "--skip-git-repo-check");
			const extra = extraArgs();
			if (extra.length) args.push(...extra);
			if (resolved.flagValue) args.push("-m", resolved.flagValue);
			// Reasoning effort is passed as a codex `-c key=value` config override.
			// The literal double-quotes are TOML string delimiters (codex parses
			// `-c` values as TOML), NOT shell quoting — shell:false sends them
			// through verbatim. `reasoning` is enum-constrained above, so the
			// quotes are required for codex to parse it as a string, not safety.
			args.push("-c", `model_reasoning_effort="${reasoning}"`);
			if (!isContinuation) {
				// resume does not accept -C or -s; the session keeps its original
				// cwd and sandbox. Only apply them on fresh runs.
				args.push("-C", cwd, "-s", sandbox);
			}
			// NOTE: -m and -c ARE accepted by `codex exec resume` (verified,
			// codex-cli 0.142.5) and are intentionally sent on continuation runs
			// too — otherwise resume defaults to a different model than the
			// session was recorded with, producing a "session recorded with X
			// but resuming with Y" warning. Keeping -m/-c pins the resumed
			// session to the model the caller requested.
			if (isContinuation) args.push(rawSessionId as string);
			// `--` ends option parsing so a prompt beginning with a dash (e.g. a
			// task literally starting "--help" or "-v") is treated as the prompt
			// positional, not a codex flag. Verified accepted in both fresh and
			// resume modes (codex-cli 0.142.5).
			args.push("--", params.prompt);

			const details: CodexDetails = {
				model: requestedModel,
				resolvedModel: resolved.flagValue,
				sessionId: isContinuation ? (rawSessionId as string) : null,
				exitCode: 0,
				aborted: false,
				timedOut: false,
				durationMs: 0,
				usage: null,
				stderr: "",
			};

			// Accumulators parsed from the JSONL stream.
			let finalMessage = "";
			const statusLines: string[] = [];

			// Throttled status updates: emit a short composed status on an
			// interval instead of re-parsing on every stdout chunk.
			const statusInterval = onUpdate
				? setInterval(() => {
						const elapsed = Math.floor((Date.now() - start) / 1000);
						const tail = statusLines.slice(-3).join("\n");
						const text = tail
							? `(running ${elapsed}s)\n${tail}`
							: `(running ${elapsed}s)`;
						onUpdate({
							content: [{ type: "text", text }],
							details: { ...details, durationMs: Date.now() - start },
						});
					}, STATUS_INTERVAL_MS)
				: null;

			// stderr accumulates inside the spawn closure; declared in the
			// enclosing scope so both the success path and catch can surface it.
			let stderrBuf = "";
			try {
				const outcome = await new Promise<{
					exitCode: number;
					aborted: boolean;
					timedOut: boolean;
				}>((resolveP, rejectP) => {
					const proc = spawn(binary, args, {
						cwd,
						stdio: ["ignore", "pipe", "pipe"],
						shell: false,
						detached: true,
					});

					// Buffer raw bytes; split on newline; parse each complete
					// line as JSON. Incomplete trailing bytes wait for more data.
					let stdoutBuf = "";
					proc.stdout?.setEncoding("utf8");
					proc.stderr?.setEncoding("utf8");

					const handleLine = (line: string) => {
						const trimmed = line.trim();
						if (!trimmed) return;
						let ev: CodexEvent;
						try {
							ev = JSON.parse(trimmed) as CodexEvent;
						} catch {
							return; // not JSON — ignore (shouldn't happen with --json)
						}
						consumeEvent(ev);
					};

					/** Apply one parsed event: capture session id, final message,
					 *  usage; push a status line for item.* events. */
					const consumeEvent = (ev: CodexEvent) => {
						switch (ev.type) {
							case "thread.started":
								if (ev.thread_id) details.sessionId = ev.thread_id;
								break;
							case "item.started": {
								const line = describeItem(ev, "started");
								if (line) statusLines.push(line);
								break;
							}
							case "item.completed": {
								// Final agent message: capture as the answer.
								if (ev.item?.type === "agent_message" && ev.item.text) {
									finalMessage = ev.item.text;
								}
								const line = describeItem(ev, "completed");
								if (line) statusLines.push(line);
								break;
							}
							case "turn.completed":
								if (ev.usage) {
									details.usage = {
										inputTokens: ev.usage.input_tokens ?? 0,
										outputTokens: ev.usage.output_tokens ?? 0,
										reasoningTokens: ev.usage.reasoning_output_tokens ?? 0,
									};
								}
								break;
							case "turn.failed":
								// Surface the failure message; non-zero exit will
								// produce the error result branch below.
								if (ev.error?.message) statusLines.push(`failed: ${shorten(ev.error.message, 200)}`);
								break;
							case "error":
								// Transient reconnect notices ("Reconnecting... 1/5")
								// are non-fatal; surface as progress, not failure.
								if (ev.message) statusLines.push(shorten(ev.message, 200));
								break;
						}
					};

					proc.stdout?.on("data", (d: string) => {
						stdoutBuf += d;
						let nl: number;
						while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
							handleLine(stdoutBuf.slice(0, nl));
							stdoutBuf = stdoutBuf.slice(nl + 1);
						}
					});
					proc.stderr?.on("data", (d: string) => {
						stderrBuf += d;
					});

					let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
					let watchdog: ReturnType<typeof setTimeout> | undefined;
					let settled = false;
					let timedOut = false;

					const killTree = () => {
						try {
							if (proc.pid) process.kill(-proc.pid, "SIGTERM");
						} catch {}
						if (!sigkillTimer) {
							sigkillTimer = setTimeout(() => {
								try {
									if (proc.pid) process.kill(-proc.pid, "SIGKILL");
								} catch {}
							}, GRACE_AFTER_TIMEOUT_MS);
						}
					};

					const cleanup = () => {
						if (watchdog) clearTimeout(watchdog);
						if (sigkillTimer) clearTimeout(sigkillTimer);
						if (signal) signal.removeEventListener("abort", onAbort);
					};

					const onAbort = () => killTree();

					watchdog = setTimeout(() => {
						timedOut = true;
						killTree();
					}, timeoutMin * 60_000);

					if (signal) {
						if (signal.aborted) killTree();
						else signal.addEventListener("abort", onAbort, { once: true });
					}

					const finish = (code: number | null) => {
						if (settled) return;
						settled = true;
						cleanup();
						// Flush any trailing line without a newline.
						if (stdoutBuf.trim()) handleLine(stdoutBuf);
						resolveP({
							exitCode: code ?? 0,
							aborted: !!signal?.aborted,
							timedOut,
						});
					};

					proc.on("error", (err) => {
						cleanup();
						rejectP(err);
					});
					proc.on("close", finish);
				});

				if (statusInterval) clearInterval(statusInterval);

				// Filter noise from stderr (codex prints "Reading additional
				// input from stdin..." and PATH warnings that aren't errors).
				details.stderr = cleanStderr(stderrBuf);
				details.exitCode = outcome.exitCode;
				details.aborted = outcome.aborted;
				details.timedOut = outcome.timedOut;
				details.durationMs = Date.now() - start;

				const text = finalMessage.trim();

				if (outcome.aborted) {
					return {
						content: [
							{
								type: "text",
								text: text
									? `codex was aborted. Partial answer:\n\n${text}`
									: "codex was aborted before producing output.",
							},
						],
						details,
					};
				}

				if (outcome.timedOut) {
					const note = `codex exceeded the ${timeoutMin}m timeout and was killed`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Non-zero exit: surface the failure even when partial text
				// exists, instead of returning silent success.
				if (outcome.exitCode !== 0) {
					const note = details.stderr.trim()
						? `codex exited with status ${outcome.exitCode}: ${details.stderr.trim()}`
						: `codex exited with status ${outcome.exitCode}`;
					return {
						content: [
							{ type: "text", text: text ? `${text}\n\n[${note}]` : note },
						],
						details,
					};
				}

				// Clear the last partial status line so the running preview
				// doesn't linger under the final answer.
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: { ...details },
				});

				// Append a session footer so the orchestrating model can see
				// (and thread) the id without inspecting details.
				const footer = details.sessionId
					? `\n\n[codex sessionId: ${details.sessionId} — pass as sessionId to continue this conversation]`
					: "";
				const usageSuffix = details.usage
					? `\n[tokens: ${details.usage.inputTokens} in / ${details.usage.outputTokens} out${details.usage.reasoningTokens > 0 ? ` / ${details.usage.reasoningTokens} reasoning` : ""}]`
					: "";

				return {
					content: [{ type: "text", text: (text || "(codex returned no message)") + footer + usageSuffix }],
					details,
				};
			} catch (err) {
				if (statusInterval) clearInterval(statusInterval);
				details.stderr = cleanStderr(stderrBuf);
				details.durationMs = Date.now() - start;
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `failed to run codex: ${msg}` }],
					details,
				};
			}
		},
	});
}

/** Drop codex stderr lines that aren't real errors: the stdin-prompt notice
 *  and the PATH-update warning. Modeled on pi-codex's cleanCodexStderr. */
function cleanStderr(buf: string): string {
	return buf
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(
			(l) =>
				l &&
				!l.startsWith("Reading additional input from stdin") &&
				!l.startsWith("WARNING: proceeding, even though we could not update PATH:"),
		)
		.join("\n");
}
