/**
 * Memory routes have been split into separate modules:
 * - memories-crud.ts: list, get, create, update, delete, versions
 * - memories-stats.ts: stats, metrics, activity, stale, report
 * - memories-search.ts: search, hybrid, bm25
 * - memories-bulk.ts: bulk-forget, bulk-update
 * - memories-io.ts: export, import
 * - memories-misc.ts: health, extract, clean, inject
 *
 * This stub remains for backwards compatibility.
 */

// Import all submodules to register their routes
import "./memories-crud.js";
import "./memories-stats.js";
import "./memories-search.js";
import "./memories-bulk.js";
import "./memories-io.js";
import "./memories-misc.js";
