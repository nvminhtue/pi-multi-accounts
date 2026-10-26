/**
 * pi-multi-accounts, Codex part — use extra ChatGPT (Codex) logins in parallel
 * with the built-in `openai-codex` provider.
 *
 * Every ~/.codex-<name>/auth.json (Codex CLI format) becomes a separate Pi
 * provider `openai-codex-<name>` with the same models as `openai-codex`, e.g.
 * ~/.codex-huy → `openai-codex-huy/gpt-5.5`. Streaming reuses Pi's built-in
 * `openai-codex-responses` implementation; the chatgpt-account-id header is
 * derived from the access token, so each provider talks as its own account.
 *
 * Setup: `CODEX_HOME=~/.codex-<name> codex login`, then `/account login codex
 * <name>` imports the tokens from the file (no browser) and registers the
 * provider when the home is new. Then pick it with /account or /model.
 *
 * The Codex auth file stays the source of truth: on refresh the extension
 * first adopts newer tokens from the file (e.g. refreshed by
 * `CODEX_HOME=~/.codex-<name> codex`), otherwise it refreshes with the file's
 * refresh token and writes the rotated tokens back, so Pi and the Codex CLI
 * keep sharing one valid login.
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mutateAuth, readAuth } from "./claude.ts";
import type { CodexEntry, CodexUsage } from "./accounts.ts";
import { fetchCodexUsage, settle } from "./usage.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const EXPIRY_SKEW_MS = 5 * 60_000;
const HOME_DIR_PATTERN = /^\.codex-([a-z0-9][a-z0-9_-]*)$/i;
const BUILTIN_PROVIDER = "openai-codex";

interface CodexAuthFile {
	auth_mode?: string;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
	last_refresh?: string;
	[key: string]: unknown;
}

export interface CodexCred {
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
	[key: string]: unknown;
}

export interface CodexHome {
	name: string;
	dir: string;
	authPath: string;
}

function jwtClaims(token: string): Record<string, unknown> {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("access token is not a JWT");
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		throw new Error("Failed to parse JWT payload");
	}
}

function readAuthFile(path: string): CodexAuthFile {
	// Tolerate non-breaking-space indentation left by copy/paste.
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/\u00a0/g, " "));
	} catch {
		// Never surface the parser message: it can quote token characters.
		throw new Error(`${path} is missing or not valid JSON`);
	}
}

export function credFromTokens(access: string, refresh: string): CodexCred {
	const claims = jwtClaims(access) as Record<string, unknown>;
	const authClaim = claims[JWT_AUTH_CLAIM];
	const accountId = typeof authClaim === "object" && authClaim !== null
		? (authClaim as Record<string, unknown>).chatgpt_account_id
		: undefined;
	if (typeof accountId !== "string" || !accountId) throw new Error("access token has no chatgpt_account_id");
	if (typeof claims.exp !== "number") throw new Error("access token has no exp claim");
	return { access, refresh, expires: claims.exp * 1000, accountId };
}

export function credFromFile(path: string): CodexCred {
	const tokens = readAuthFile(path).tokens;
	if (!tokens?.access_token || !tokens.refresh_token) {
		throw new Error(`${path} has no ChatGPT tokens; run \`CODEX_HOME=${join(path, "..")} codex login\` first`);
	}
	return credFromTokens(tokens.access_token, tokens.refresh_token);
}

export function writeBack(path: string, fresh: { access: string; refresh: string; idToken?: string; accountId: string }): void {
	const file = readAuthFile(path);
	file.tokens = {
		...file.tokens,
		access_token: fresh.access,
		refresh_token: fresh.refresh,
		...(fresh.idToken ? { id_token: fresh.idToken } : {}),
		account_id: fresh.accountId,
	};
	file.last_refresh = new Date().toISOString();
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export function isFresh(cred: CodexCred, now = Date.now()): boolean {
	return cred.expires - now > EXPIRY_SKEW_MS;
}

/** True when the auth file holds newer, still-valid tokens than `currentAccess`. */
export function shouldAdopt(fromFile: CodexCred, currentAccess: string, now = Date.now()): boolean {
	return fromFile.access !== currentAccess && isFresh(fromFile, now);
}

export async function refreshCred(home: CodexHome, refreshToken: string, signal: AbortSignal): Promise<CodexCred> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
		signal,
	});
	if (!response.ok) {
		// The Codex CLI may have rotated the single-use refresh token meanwhile.
		const latest = credFromFile(home.authPath);
		if (latest.refresh !== refreshToken && isFresh(latest)) return latest;
		const body = (await response.json().catch(() => ({}))) as { error?: unknown };
		const code = typeof body.error === "string" ? ` (${body.error})` : "";
		throw new Error(
			`OpenAI Codex (${home.name}) token refresh failed: HTTP ${response.status}${code}. ` +
				`Run \`CODEX_HOME=${home.dir} codex login\`, then /account login codex ${home.name}.`,
		);
	}
	const json = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
	if (!json.access_token) throw new Error(`OpenAI Codex (${home.name}) token refresh returned no access token`);
	const cred = credFromTokens(json.access_token, json.refresh_token ?? refreshToken);
	try {
		writeBack(home.authPath, { ...cred, idToken: json.id_token });
	} catch (error) {
		// Pi still persists the rotated token; only the Codex CLI copy is stale.
		console.warn(`pi-multi-accounts: could not update ${home.authPath}: ${(error as Error).message}`);
	}
	return cred;
}

export function discoverHomes(root = homedir()): CodexHome[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && HOME_DIR_PATTERN.test(entry.name))
		.map((entry) => ({
			name: (HOME_DIR_PATTERN.exec(entry.name)?.[1] ?? entry.name).toLowerCase(),
			dir: join(root, entry.name),
			authPath: join(root, entry.name, "auth.json"),
		}))
		.filter((home) => existsSync(home.authPath));
}

function codexModels(): ProviderModelConfig[] {
	return getBuiltinModels("openai-codex").map(({ provider: _provider, ...model }) => ({ ...model }) as ProviderModelConfig);
}

function registerHome(pi: ExtensionAPI, home: CodexHome, models: ProviderModelConfig[]): void {
	pi.registerProvider(`openai-codex-${home.name}`, {
		name: `OpenAI Codex (${home.name})`,
		baseUrl: BASE_URL,
		api: "openai-codex-responses",
		models,
		oauth: {
			name: `OpenAI Codex (${home.name})`,
			isSubscription: true,
			async login(callbacks) {
				const cred = credFromFile(home.authPath);
				callbacks.onProgress?.(`Imported ChatGPT login from ${home.authPath}`);
				return cred;
			},
			async refreshToken(credentials, signal) {
				// Adopt tokens the Codex CLI refreshed meanwhile; otherwise refresh ourselves.
				const fromFile = credFromFile(home.authPath);
				if (shouldAdopt(fromFile, credentials.access)) return fromFile;
				return refreshCred(home, fromFile.refresh, signal);
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
}

export function registerCodex(pi: ExtensionAPI, homes = discoverHomes()): CodexHome[] {
	const models = codexModels();
	for (const home of homes) registerHome(pi, home, models);
	return homes;
}

/** One adapter per registration snapshot; /account login codex registers homes created later. */
export function createCodexProvider(pi: ExtensionAPI, homes: readonly CodexHome[]) {
	const registeredHomes = [...homes];
	const getProviderId = (home: CodexHome) => `openai-codex-${home.name}`;
	const getIds = () => registeredHomes.map(getProviderId);

	function getEntries(ctx: ExtensionContext): CodexEntry[] {
		const auth = readAuth();
		return registeredHomes.map((home) => {
			const id = getProviderId(home);
			const credential = auth[id] as { type?: unknown } | undefined;
			return {
				provider: "codex",
				id,
				name: home.name,
				authPath: home.authPath,
				isLoggedIn: credential?.type === "oauth",
				isActive: ctx.model?.provider === id,
			};
		});
	}

	function notifyLogin(id: string, ctx: ExtensionContext): void {
		const home = registeredHomes.find((home) => getProviderId(home) === id);
		ctx.ui.notify(`No configured auth for ${id}. Run /account login codex ${home?.name} first.`, "error");
	}

	async function chooseModel(id: string, ctx: ExtensionContext) {
		const models = ctx.modelRegistry.getAll().filter((model) => model.provider === id);
		if (!models.length) {
			ctx.ui.notify(`No registered models for ${id}. Run /reload.`, "error");
			return;
		}
		const available = models.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
		if (!available.length) return notifyLogin(id, ctx);
		if (!ctx.hasUI) {
			ctx.ui.notify(`Choose a model for ${id} explicitly with /model.`, "warning");
			return;
		}
		const labels = available.map((model) => `${model.name} (${model.id})`);
		const choice = await ctx.ui.select(`Choose a model for ${id}`, labels);
		return available.find((_model, index) => labels[index] === choice);
	}

	async function useAccount(id: string, ctx: ExtensionContext): Promise<void> {
		if (!getIds().includes(id)) {
			ctx.ui.notify(`Unknown Codex provider "${id}". Run /account login codex <name> to add a home.`, "error");
			return;
		}
		const sameModel = ctx.model ? ctx.modelRegistry.find(id, ctx.model.id) : undefined;
		const model = sameModel ?? await chooseModel(id, ctx);
		if (!model) return;
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) return notifyLogin(id, ctx);
		const hasChanged = await pi.setModel(model);
		if (!hasChanged) return notifyLogin(id, ctx);
		ctx.ui.notify(`Switched this session to ${id}/${model.id}.`, "info");
	}

	/** Existing ~/.codex-<name> by name, else the path `codex login` should create. */
	function findHome(name: string): CodexHome {
		const known = [...registeredHomes, ...discoverHomes()].find((home) => home.name === name);
		const dir = join(homedir(), `.codex-${name}`);
		return known ?? { name, dir, authPath: join(dir, "auth.json") };
	}

	/** Undefined when cancelled. */
	async function pickName(ctx: ExtensionContext): Promise<string | undefined> {
		const names = [...new Set([...registeredHomes, ...discoverHomes()].map((home) => home.name))];
		const other = "Another ChatGPT account (new ~/.codex-<name>)";
		const choice = names.length ? await ctx.ui.select("Log in which Codex home?", [...names, other]) : other;
		if (choice !== other) return choice;
		return (await ctx.ui.input("Name for the Codex home (~/.codex-<name>)", "e.g. work"))?.trim() || undefined;
	}

	/** Import ~/.codex-<name>/auth.json into Pi, i.e. the built-in /login → "OpenAI Codex (<name>)". */
	async function login(rawName: string, ctx: ExtensionContext): Promise<void> {
		let name = rawName.toLowerCase();
		if (!name && ctx.hasUI) {
			name = (await pickName(ctx))?.toLowerCase() ?? "";
			if (!name) return;
		}
		if (!HOME_DIR_PATTERN.test(`.codex-${name}`)) {
			ctx.ui.notify("Usage: /account login codex <name>  (letters, digits, _ -; starts with a letter or digit)", "warning");
			return;
		}
		const home = findHome(name);
		if (!existsSync(home.authPath)) {
			ctx.ui.notify(
				[
					`No ChatGPT login in ${home.authPath} yet. In a terminal, run:`,
					`  CODEX_HOME=${home.dir} codex login`,
					"Adding another ChatGPT account? Finish that login in a private/incognito window (or sign out of chatgpt.com first); " +
						"otherwise the browser logs in the account that is already signed in.",
					`Then run /account login codex ${name} again.`,
				].join("\n"),
				"warning",
			);
			return;
		}
		const cred = credFromFile(home.authPath);
		const id = getProviderId(home);
		if (!getIds().includes(id)) {
			registerHome(pi, home, codexModels());
			registeredHomes.push(home);
		}
		await mutateAuth((auth) => {
			auth[id] = { type: "oauth", ...cred };
		});
		await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: false });
		ctx.ui.notify(`Logged in ${id} with the ChatGPT login from ${home.authPath}.`, "info");
		if (!ctx.hasUI) {
			ctx.ui.notify(`Run /account ${id} to use it in this session.`, "info");
			return;
		}
		if (await ctx.ui.confirm("Use it now?", `Switch this session to ${id}?`)) await useAccount(id, ctx);
	}

	/** Usage of the built-in openai-codex login and every logged-in Codex home. Pi refreshes expiring tokens. */
	async function getUsage(ctx: ExtensionContext): Promise<CodexUsage[]> {
		const auth = readAuth();
		const isLoggedIn = (id: string) => (auth[id] as { type?: unknown } | undefined)?.type === "oauth";
		const ids = [BUILTIN_PROVIDER, ...getIds()].filter(isLoggedIn);
		return Promise.all(
			ids.map(async (id) => ({
				id,
				isActive: ctx.model?.provider === id,
				usage: await settle(async () => {
					const access = (await ctx.modelRegistry.getProviderAuth(id))?.auth.apiKey;
					if (!access) {
						const relogin = id === BUILTIN_PROVIDER ? "/login" : `/account login codex ${id.slice(BUILTIN_PROVIDER.length + 1)}`;
						throw new Error(`no usable login; run ${relogin}`);
					}
					return fetchCodexUsage(access);
				}),
			})),
		);
	}

	return { getIds, getEntries, getUsage, useAccount, login };
}
