/**
 * pi-multi-accounts, usage part — subscription quota of a Claude or Codex login.
 *
 * Both endpoints are unofficial (the ones Claude Code and the Codex CLI poll):
 *   Claude: GET https://api.anthropic.com/api/oauth/usage   (five_hour, seven_day, limits[], spend)
 *   Codex:  GET https://chatgpt.com/backend-api/wham/usage  (plan_type, rate_limit, additional_rate_limits)
 * Fetchers take an access token; getting a fresh one is the provider adapters' job.
 */

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const USAGE_TIMEOUT_MS = 10_000;
const BAR_WIDTH = 10;

export interface UsageWindow {
	label: string;
	/** 0–100 */
	percent: number;
	resetsAt?: number;
}

export interface UsageReport {
	plan?: string;
	windows: UsageWindow[];
	/** One-line facts outside the windows, e.g. extra usage spend or a reached limit. */
	notes: string[];
}

export type UsageResult = { ok: true; report: UsageReport } | { ok: false; error: string };

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const toNumber = (value: unknown): number | undefined => {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

function parseIsoTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Runs `fn`, turning a throw into a displayable failure. */
export async function settle(fn: () => Promise<UsageReport>): Promise<UsageResult> {
	try {
		return { ok: true, report: await fn() };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
	if (!res.ok) {
		const hint = res.status === 401 || res.status === 403 ? " (login expired or revoked?)" : res.status === 429 ? " (rate limited, try later)" : "";
		throw new Error(`usage request failed: HTTP ${res.status}${hint}`);
	}
	return res.json();
}

// ---------- Claude ----------

function claudeWindow(label: string, bucket: unknown, percentKey: "utilization" | "percent"): UsageWindow | undefined {
	if (!isRecord(bucket)) return undefined;
	const percent = toNumber(bucket[percentKey]);
	if (percent === undefined) return undefined;
	return { label, percent: clampPercent(percent), resetsAt: parseIsoTime(bucket.resets_at) };
}

function money(minor: unknown, exponent: unknown): number | undefined {
	const amount = toNumber(minor);
	const exp = toNumber(exponent) ?? 2;
	return amount === undefined ? undefined : amount / 10 ** exp;
}

/** `spend` (current) or `extra_usage` (older payloads); only when the account has it switched on. */
function claudeExtraUsage(payload: Json): string | undefined {
	let used: number | undefined;
	let limit: number | undefined;
	const spend = payload.spend;
	const legacy = payload.extra_usage;
	if (isRecord(spend)) {
		if (spend.enabled !== true || !isRecord(spend.used)) return undefined;
		used = money(spend.used.amount_minor, spend.used.exponent);
		if (isRecord(spend.limit)) limit = money(spend.limit.amount_minor, spend.limit.exponent);
	} else if (isRecord(legacy)) {
		if (legacy.is_enabled !== true) return undefined;
		used = money(legacy.used_credits, legacy.decimal_places);
		limit = money(legacy.monthly_limit, legacy.decimal_places);
	}
	if (used === undefined) return undefined;
	return limit ? `extra usage $${used.toFixed(2)} / $${limit.toFixed(2)}` : `extra usage $${used.toFixed(2)}`;
}

export function parseClaudeUsage(payload: unknown): UsageReport {
	if (!isRecord(payload)) throw new Error("usage response is not a JSON object");
	const limits = Array.isArray(payload.limits) ? payload.limits.filter(isRecord) : [];
	const limitOf = (kind: string) => limits.find((limit) => limit.kind === kind);
	const windows = [
		claudeWindow("5h", payload.five_hour, "utilization") ?? claudeWindow("5h", limitOf("session"), "percent"),
		claudeWindow("7d", payload.seven_day, "utilization") ?? claudeWindow("7d", limitOf("weekly_all"), "percent"),
		// Legacy per-model weekly buckets; newer payloads send them as `weekly_scoped` limits.
		claudeWindow("7d Opus", payload.seven_day_opus, "utilization"),
		claudeWindow("7d Sonnet", payload.seven_day_sonnet, "utilization"),
	];
	for (const limit of limits) {
		if (limit.kind !== "weekly_scoped") continue;
		const name = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model.display_name : undefined;
		const label = typeof name === "string" && name.trim() ? `7d ${name.trim()}` : undefined;
		if (label && !windows.some((window) => window?.label === label)) windows.push(claudeWindow(label, limit, "percent"));
	}
	const extra = claudeExtraUsage(payload);
	return { windows: windows.filter((window) => window !== undefined), notes: extra ? [extra] : [] };
}

export async function fetchClaudeUsage(access: string): Promise<UsageReport> {
	const payload = await getJson(CLAUDE_USAGE_URL, {
		Authorization: `Bearer ${access}`,
		"anthropic-beta": "oauth-2025-04-20",
		"Content-Type": "application/json",
	});
	return parseClaudeUsage(payload);
}

// ---------- Codex ----------

/** 18000 → "5h", 604800 → "7d", 2592000 → "30d". */
function windowLabel(seconds: number | undefined, fallback: string): string {
	if (seconds === undefined || seconds <= 0) return fallback;
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	return `${Math.max(1, Math.round(seconds / 3_600))}h`;
}

function codexWindow(window: unknown, fallback: string, suffix: string, now: number): UsageWindow | undefined {
	if (!isRecord(window)) return undefined;
	const percent = toNumber(window.used_percent);
	if (percent === undefined) return undefined;
	const resetAt = toNumber(window.reset_at);
	const resetAfter = toNumber(window.reset_after_seconds);
	const resetsAt =
		resetAt !== undefined ? (resetAt > 1e12 ? resetAt : resetAt * 1000) : resetAfter !== undefined ? now + resetAfter * 1000 : undefined;
	const label = windowLabel(toNumber(window.limit_window_seconds), fallback) + suffix;
	return { label, percent: clampPercent(percent), resetsAt };
}

function codexWindows(rateLimit: unknown, suffix: string, now: number): UsageWindow[] {
	if (!isRecord(rateLimit)) return [];
	return [
		codexWindow(rateLimit.primary_window, "primary", suffix, now),
		codexWindow(rateLimit.secondary_window, "secondary", suffix, now),
	].filter((window) => window !== undefined);
}

export function parseCodexUsage(payload: unknown, now = Date.now()): UsageReport {
	if (!isRecord(payload)) throw new Error("usage response is not a JSON object");
	const plan = typeof payload.plan_type === "string" && payload.plan_type ? payload.plan_type : undefined;
	const windows = codexWindows(payload.rate_limit, "", now);
	const notes: string[] = [];
	if (isRecord(payload.rate_limit) && payload.rate_limit.limit_reached === true) notes.push("limit reached");
	for (const extra of Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []) {
		if (!isRecord(extra)) continue;
		const name = typeof extra.limit_name === "string" && extra.limit_name ? extra.limit_name : extra.metered_feature;
		windows.push(...codexWindows(extra.rate_limit, typeof name === "string" && name ? ` ${name}` : " extra", now));
	}
	const credits = payload.credits;
	if (isRecord(credits)) {
		const balance = toNumber(credits.balance);
		if (credits.unlimited === true) notes.push("credits: unlimited");
		else if (credits.has_credits === true && balance !== undefined) notes.push(`credits: ${balance}`);
	}
	return { plan, windows, notes };
}

/** The ChatGPT account id the token was minted for (sent as ChatGPT-Account-Id). */
function codexAccountId(access: string): string | undefined {
	try {
		const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Json;
		const auth = claims[JWT_AUTH_CLAIM];
		return isRecord(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchCodexUsage(access: string, now = Date.now()): Promise<UsageReport> {
	const accountId = codexAccountId(access);
	const payload = await getJson(CODEX_USAGE_URL, {
		Authorization: `Bearer ${access}`,
		"User-Agent": "codex_cli_rs",
		...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
	});
	return parseCodexUsage(payload, now);
}

// ---------- formatting ----------

/** 2h 13m, 4d 3h, 12m; "<1m" when under a minute or already passed. */
export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes <= 0) return "<1m";
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
	if (hours) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	return `${minutes}m`;
}

/** Indented detail lines for one account: a bar per window, then notes, or the error. */
export function formatUsage(result: UsageResult, now = Date.now()): string[] {
	if (!result.ok) return [`    error: ${result.error}`];
	const { windows, notes } = result.report;
	const width = Math.max(0, ...windows.map((window) => window.label.length));
	const lines = windows.map((window) => {
		const filled = Math.round((window.percent / 100) * BAR_WIDTH);
		const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
		const percent = `${Math.round(window.percent)}%`.padStart(4);
		const reset = window.resetsAt === undefined ? "" : `  resets in ${formatDuration(window.resetsAt - now)}`;
		return `    ${window.label.padEnd(width)}  ${bar} ${percent}${reset}`;
	});
	lines.push(...notes.map((note) => `    ${note}`));
	return lines.length ? lines : ["    no usage reported"];
}
