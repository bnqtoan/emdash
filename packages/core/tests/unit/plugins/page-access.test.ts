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

import { resolvePageAccess } from "../../../src/page/access.js";
import { HookPipeline } from "../../../src/plugins/hooks.js";
import type {
	ResolvedPlugin,
	ResolvedHook,
	PageAccessHandler,
	PageAccessVerdict,
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
		const good: PageAccessHandler = vi.fn(async () => ({
			allow: false as const,
			reason: "paywall",
		}));

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

// ---------------------------------------------------------------------------
// Runtime wiring — the page:access pass folded into page contributions
//
// `doCollectPageContributions` (emdash-runtime.ts) gates the new pass on
// `hasHooks("page:access")`, then composes `runPageAccess` + `resolvePageAccess`
// into `PageContributions.access` — exactly the metadata/fragments pattern.
//
// These tests exercise that composition directly against a HookPipeline. The
// full EmDashRuntime can't be constructed in this unit suite (it pulls in the
// auth Kysely adapter, an unbuilt workspace subpath), so we assert the wiring
// contract — registered gate ⇒ resolved verdict; no gate ⇒ verdict absent —
// against the same two primitives the runtime calls, in the same order.
// ---------------------------------------------------------------------------

/** Mirror of the access pass in doCollectPageContributions. */
async function collectAccess(
	pipeline: HookPipeline,
	page: PublicPageContext,
	visitor: PageAccessVisitor | null,
): Promise<(PageAccessVerdict & { blockedBy?: string }) | undefined> {
	if (!pipeline.hasHooks("page:access")) return undefined;
	const verdicts = await pipeline.runPageAccess({ page, visitor });
	return resolvePageAccess(verdicts);
}

function gatePlugin(handler: PageAccessHandler, id = "paywall"): ResolvedPlugin {
	return createTestPlugin({
		id,
		capabilities: [GATE_CAP],
		hooks: { "page:access": createTestHook(id, handler) },
	});
}

describe("page contributions — page:access wiring", () => {
	it("blocks: folds a block verdict into access.allow === false", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({
			allow: false as const,
			reason: "paywall",
			teaser: [{ _type: "block", children: [{ text: "Members only." }] }],
			redirect: "/subscribe",
		}));
		const pipeline = new HookPipeline([gatePlugin(handler)], { db });

		const access = await collectAccess(pipeline, createPageContext(), null);

		expect(access).toBeDefined();
		expect(access!.allow).toBe(false);
		if (access!.allow === false) {
			expect(access!.reason).toBe("paywall");
			expect(access!.teaser).toBeDefined();
			expect(access!.redirect).toBe("/subscribe");
		}
		expect(access!.blockedBy).toBe("paywall");
		expect(handler).toHaveBeenCalledOnce();
	});

	it("allows: a gate that allows yields access.allow === true", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({ allow: true as const }));
		const pipeline = new HookPipeline([gatePlugin(handler)], { db });

		const access = await collectAccess(pipeline, createPageContext(), null);

		expect(access).toEqual({ allow: true });
	});

	it("no gate registered: access is absent (no regression, full body)", async () => {
		const pipeline = new HookPipeline([], { db });

		expect(pipeline.hasHooks("page:access")).toBe(false);
		const access = await collectAccess(pipeline, createPageContext(), null);

		expect(access).toBeUndefined();
	});

	it("passes the host-resolved visitor through to the gate", async () => {
		const handler: PageAccessHandler = vi.fn(async () => ({ allow: true as const }));
		const pipeline = new HookPipeline([gatePlugin(handler)], { db });
		const visitor: PageAccessVisitor = { id: "cust_7", tiers: ["premium"] };

		await collectAccess(pipeline, createPageContext(), visitor);

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ visitor: expect.objectContaining({ id: "cust_7" }) }),
			expect.anything(),
		);
	});

	it("first block wins across multiple gates (priority order)", async () => {
		const high: PageAccessHandler = vi.fn(async () => ({
			allow: false as const,
			reason: "paywall",
		}));
		const low: PageAccessHandler = vi.fn(async () => ({
			allow: false as const,
			reason: "members",
		}));
		const pipeline = new HookPipeline(
			[
				createTestPlugin({
					id: "paywall",
					capabilities: [GATE_CAP],
					hooks: { "page:access": createTestHook("paywall", high, { priority: 1 }) },
				}),
				createTestPlugin({
					id: "members",
					capabilities: [GATE_CAP],
					hooks: { "page:access": createTestHook("members", low, { priority: 2 }) },
				}),
			],
			{ db },
		);

		const access = await collectAccess(pipeline, createPageContext(), null);

		expect(access!.allow).toBe(false);
		if (access!.allow === false) expect(access!.reason).toBe("paywall");
		expect(access!.blockedBy).toBe("paywall");
	});
});
