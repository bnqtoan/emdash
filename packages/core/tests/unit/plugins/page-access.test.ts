/**
 * Page Access Hook Tests
 *
 * Tests the page:access hook + verdict resolution — the generic content-gate
 * hook that powers paywalls, members-only content, and personalized gating.
 *
 * Verifies:
 * - the hook fires through HookPipeline with the visitor + page context
 * - allow / block verdicts are returned per plugin
 * - registration requires the hooks.page-access:register capability
 * - errors in a gate plugin are isolated (and don't yield a verdict)
 * - resolvePageAccess folds verdicts with "first block wins"
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { HookPipeline } from "../../../src/plugins/hooks.js";
import { resolvePageAccess } from "../../../src/page/access.js";
import type {
	ResolvedPlugin,
	ResolvedHook,
	PageAccessHandler,
	PublicPageContext,
	PageAccessVisitor,
} from "../../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors page-hooks-execution.test.ts)
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [] },
		hooks: {},
		routes: {},
		...overrides,
	};
}

function createTestHook<T>(
	pluginId: string,
	handler: T,
	overrides: Partial<ResolvedHook<T>> = {},
): ResolvedHook<T> {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		...overrides,
	};
}

function createPageContext(overrides: Partial<PublicPageContext> = {}): PublicPageContext {
	return {
		url: "https://example.com/blog/paid-post",
		path: "/blog/paid-post",
		locale: null,
		kind: "content",
		pageType: "post",
		title: "A Paid Post",
		description: null,
		canonical: null,
		image: null,
		content: { collection: "posts", id: "post_123", slug: "paid-post" },
		...overrides,
	};
}

const GATE_CAP = "hooks.page-access:register";

let db: Kysely<any>;
let sqlite: InstanceType<typeof Database>;

beforeEach(() => {
	sqlite = new Database(":memory:");
	db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
});

afterEach(async () => {
	await db.destroy();
	sqlite.close();
});

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

describe("page:access hook execution", () => {
	it("runs the handler and returns an allow verdict", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({ allow: true as const }));

		const plugin = createTestPlugin({
			id: "paywall",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("paywall", handler) },
		});

		const pipeline = new HookPipeline([plugin], { db });
		const results = await pipeline.runPageAccess({ page: createPageContext(), visitor: null });

		expect(results).toHaveLength(1);
		expect(results[0]!.pluginId).toBe("paywall");
		expect(results[0]!.verdict).toEqual({ allow: true });
		expect(handler).toHaveBeenCalledOnce();
	});

	it("returns a block verdict with teaser + reason", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({
			allow: false as const,
			reason: "paywall",
			teaser: [{ _type: "block", children: [{ text: "Members only — scan to unlock." }] }],
		}));

		const plugin = createTestPlugin({
			id: "paywall",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("paywall", handler) },
		});

		const pipeline = new HookPipeline([plugin], { db });
		const results = await pipeline.runPageAccess({ page: createPageContext(), visitor: null });

		expect(results).toHaveLength(1);
		const v = results[0]!.verdict;
		expect(v.allow).toBe(false);
		if (v.allow === false) {
			expect(v.reason).toBe("paywall");
			expect(v.teaser).toBeDefined();
		}
	});

	it("passes page + visitor (with claims) to the handler", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({ allow: true as const }));
		const visitor: PageAccessVisitor = {
			id: "cust_42",
			email: "reader@example.com",
			tiers: ["premium"],
			expiresAt: "2026-12-31",
		};

		const plugin = createTestPlugin({
			id: "paywall",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("paywall", handler) },
		});

		const pipeline = new HookPipeline([plugin], { db });
		await pipeline.runPageAccess({ page: createPageContext({ path: "/x" }), visitor });

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				page: expect.objectContaining({ path: "/x" }),
				visitor: expect.objectContaining({ id: "cust_42", tiers: ["premium"] }),
			}),
			expect.anything(),
		);
	});

	it("treats a null return as no verdict", async () => {
		const handler: PageAccessHandler = vi.fn(async () => null);

		const plugin = createTestPlugin({
			id: "noop",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("noop", handler) },
		});

		const pipeline = new HookPipeline([plugin], { db });
		const results = await pipeline.runPageAccess({ page: createPageContext(), visitor: null });

		expect(results).toHaveLength(0);
	});

	it("isolates errors — a crashing gate yields no verdict, others still run", async () => {
		const bad: PageAccessHandler = vi.fn(async () => {
			throw new Error("gate crashed");
		});
		const good: PageAccessHandler = vi.fn(async () => ({ allow: false as const, reason: "paywall" }));

		const badPlugin = createTestPlugin({
			id: "bad",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("bad", bad, { priority: 1 }) },
		});
		const goodPlugin = createTestPlugin({
			id: "good",
			capabilities: [GATE_CAP],
			hooks: { "page:access": createTestHook("good", good, { priority: 2 }) },
		});

		const pipeline = new HookPipeline([badPlugin, goodPlugin], { db });
		const results = await pipeline.runPageAccess({ page: createPageContext(), visitor: null });

		expect(results).toHaveLength(1);
		expect(results[0]!.pluginId).toBe("good");
	});

	it("requires hooks.page-access:register capability", () => {
		const handler: PageAccessHandler = vi.fn(async () => ({ allow: true as const }));

		const noCap = createTestPlugin({
			id: "no-cap",
			capabilities: [],
			hooks: { "page:access": createTestHook("no-cap", handler) },
		});

		const pipeline = new HookPipeline([noCap], { db });
		expect(pipeline.hasHooks("page:access")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Verdict resolution
// ---------------------------------------------------------------------------

describe("resolvePageAccess", () => {
	it("allows when there are no verdicts (pre-hook behaviour)", () => {
		expect(resolvePageAccess([])).toEqual({ allow: true });
	});

	it("allows when every verdict allows", () => {
		expect(
			resolvePageAccess([
				{ pluginId: "a", verdict: { allow: true } },
				{ pluginId: "b", verdict: { allow: true } },
			]),
		).toEqual({ allow: true });
	});

	it("first block wins and records who blocked", () => {
		const resolved = resolvePageAccess([
			{ pluginId: "a", verdict: { allow: true } },
			{ pluginId: "paywall", verdict: { allow: false, reason: "paywall", redirect: "/unlock" } },
			{ pluginId: "c", verdict: { allow: false, reason: "members" } },
		]);

		expect(resolved.allow).toBe(false);
		if (resolved.allow === false) {
			expect(resolved.reason).toBe("paywall");
			expect(resolved.redirect).toBe("/unlock");
		}
		expect(resolved.blockedBy).toBe("paywall");
	});
});
