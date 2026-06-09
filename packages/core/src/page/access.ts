/**
 * Page access resolution
 *
 * Folds the per-plugin verdicts collected from the page:access hook into a
 * single decision the theme can act on. Convention: the FIRST blocking
 * verdict (in plugin priority order) wins, so a high-priority gate plugin
 * can decide before lower-priority ones. With no verdicts, access is
 * allowed — matching the pre-hook behaviour (every page fully visible).
 */

import type { PageAccessVerdict } from "../plugins/types.js";

/**
 * Resolve an ordered list of plugin verdicts into one.
 * @param verdicts per-plugin verdicts, already in plugin priority order
 */
export function resolvePageAccess(
	verdicts: Array<{ pluginId: string; verdict: PageAccessVerdict }>,
): PageAccessVerdict & { blockedBy?: string } {
	for (const { pluginId, verdict } of verdicts) {
		if (verdict.allow === false) {
			return { ...verdict, blockedBy: pluginId };
		}
	}
	return { allow: true };
}
