import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatUsage, parseClaudeUsage, parseCodexUsage } from "../src/usage.ts";

const NOW = Date.parse("2026-10-26T07:00:00Z");

test("Claude: legacy buckets win, limits[] fill null buckets, scoped weekly caps are named", () => {
	const report = parseClaudeUsage({
		five_hour: { utilization: 19.0, resets_at: "2026-10-26T11:59:59.746445+00:00" },
		seven_day: null,
		seven_day_opus: null,
		limits: [
			{ kind: "session", percent: 80, resets_at: "2026-10-26T09:00:00Z" },
			{ kind: "weekly_all", percent: 10, resets_at: "2026-11-01T23:59:59Z", is_active: false },
			{ kind: "weekly_scoped", percent: 5, resets_at: null, scope: { model: { display_name: "Fable" } } },
			{ kind: "weekly_scoped", percent: 7, scope: null },
		],
		spend: { enabled: false, used: { amount_minor: 0, exponent: 2 }, limit: { amount_minor: 8000, exponent: 2 } },
		extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 8000, decimal_places: 2 },
	});
	assert.deepEqual(report.windows, [
		{ label: "5h", percent: 19, resetsAt: Date.parse("2026-10-26T11:59:59.746Z") },
		{ label: "7d", percent: 10, resetsAt: Date.parse("2026-11-01T23:59:59Z") },
		{ label: "7d Fable", percent: 5, resetsAt: undefined },
	]);
	// `spend` is authoritative when present: switched off means no extra-usage line.
	assert.deepEqual(report.notes, []);
});

test("Claude: extra usage is shown only when enabled, from spend or the older extra_usage", () => {
	const spend = parseClaudeUsage({ spend: { enabled: true, used: { amount_minor: 1234, exponent: 2 }, limit: null } });
	assert.deepEqual(spend.notes, ["extra usage $12.34"]);
	const legacy = parseClaudeUsage({ extra_usage: { is_enabled: true, used_credits: 320, monthly_limit: 8000, decimal_places: 2 } });
	assert.deepEqual(legacy.notes, ["extra usage $3.20 / $80.00"]);
	assert.throws(() => parseClaudeUsage([]), /not a JSON object/);
});

test("Codex: windows are labelled by length, resets accept seconds, ms or reset_after", () => {
	const report = parseCodexUsage(
		{
			plan_type: "pro",
			rate_limit: {
				limit_reached: true,
				primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: 90 },
				secondary_window: { used_percent: 140, limit_window_seconds: 604_800, reset_at: 1_795_057_494 },
			},
			additional_rate_limits: [
				{ limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 2_592_000, reset_at: 1_795_057_494_000 } } },
			],
			credits: { has_credits: true, unlimited: false, balance: "12.5" },
		},
		NOW,
	);
	assert.equal(report.plan, "pro");
	assert.deepEqual(report.windows, [
		{ label: "5h", percent: 100, resetsAt: NOW + 90_000 },
		{ label: "7d", percent: 100, resetsAt: 1_795_057_494_000 },
		{ label: "30d GPT-5.3-Codex-Spark", percent: 3, resetsAt: 1_795_057_494_000 },
	]);
	assert.deepEqual(report.notes, ["limit reached", "credits: 12.5"]);
});

test("formatting aligns windows, rounds durations down and shows errors or empty reports", () => {
	const lines = formatUsage(
		{ ok: true, report: { windows: [{ label: "5h", percent: 42, resetsAt: NOW + 3_600_000 * 26 + 59_999 }, { label: "7d Opus", percent: 100 }], notes: ["limit reached"] } },
		NOW,
	);
	assert.deepEqual(lines, [
		"    5h       ████░░░░░░  42%  resets in 1d 2h",
		"    7d Opus  ██████████ 100%",
		"    limit reached",
	]);
	assert.deepEqual(formatUsage({ ok: true, report: { windows: [], notes: [] } }, NOW), ["    no usage reported"]);
	assert.deepEqual(formatUsage({ ok: false, error: "HTTP 401" }, NOW), ["    error: HTTP 401"]);
	assert.equal(formatDuration(-5), "<1m");
	assert.equal(formatDuration(59_999), "<1m");
	assert.equal(formatDuration(3_600_000 + 60_000), "1h 1m");
	assert.equal(formatDuration(2 * 86_400_000), "2d");
});
