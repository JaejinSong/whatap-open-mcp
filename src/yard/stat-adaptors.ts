// src/yard/stat-adaptors.ts
// Ports of the yard adaptors that fill the `mxql/apm/stat/*` templates for
// the WhaTap UI's statistics screens. The templates carry `<% NAME %>`
// markers that the yard fills in Java before running them; the MCP text
// endpoint does not, so the MCP has to fill them the same way.
//
// Sources (whatap server repo, whatap.server.yard):
//   web/rest/service/stat/selector/ErrorStatAdaptorMxql.java  selectStatAndFlush()
//   web/rest/service/stat/selector/HTTPCStatAdaptorMxql.java  selectStatAndFlush()
//
// One deliberate difference: the adaptors pass the screen's row count to
// LIMIT1 (`LIMIT {everytime:N}`, a per-hour top-N taken before the final
// regroup), so with a small N every hour drops everything below rank N and the
// totals shrink. Here LIMIT1 is the GROUP cap and only LIMIT2 takes the
// caller's row count.

import { CATALOG_RAW } from "../data/mxql-catalog.js";
import { fillMarkers } from "./markers.js";

/** Groups the yard keeps per GROUP step before dropping rows silently. */
export const GROUP_CAP = 10_000;
/** Adaptors switch to the hourly template at this window length. */
const HOURLY_FROM_MS = 86_400_000 - 5_000;

export interface StatQuery {
  /** Catalog path of the template that was filled. */
  path: string;
  mql: string;
}

function template(path: string): string {
  const raw = (CATALOG_RAW as Record<string, string>)[path];
  if (!raw) throw new Error(`Stat template not in catalog: ${path}`);
  return raw;
}

/** Project-wide: the adaptors' getAgent() returns "" for ObjectOption.PROJECT. */
const PROJECT_AGENT = "";

/**
 * Error statistics: rows per class + service + message, with `class`, `msg`,
 * `service` text, `count`, `snapSeq` (error snap id) and `tt` (stat time).
 */
export function errorStatQuery(stime: number, etime: number, limit: number): StatQuery {
  const path =
    etime - stime >= HOURLY_FROM_MS ? "mxql/apm/stat/error_stat_1h" : "mxql/apm/stat/error_stat";
  const order = "count";
  const mql = fillMarkers(template(path), {
    FILTER: "",
    AGENT: PROJECT_AGENT,
    ORDER1: `ORDER {key:${order}, sort:desc}`,
    ORDER2: `ORDER {key:${order}, sort:desc}`,
    LIMIT1: `LIMIT {everytime:${GROUP_CAP}}`,
    LIMIT2: `LIMIT ${limit}`,
  });
  return { path, mql };
}

/**
 * Outbound HTTP statistics: rows per host + URL + port, with `host`, `url`,
 * `service` text, `total`, `error`, `sum`, `min`, `max`, `avg` and `tt`.
 * Ordered by `error` (the adaptor's "countError").
 */
export function httpcStatQuery(stime: number, etime: number, limit: number): StatQuery {
  const path =
    etime - stime >= HOURLY_FROM_MS ? "mxql/apm/stat/httpc_stat_1h" : "mxql/apm/stat/httpc_stat";
  const order = "error";
  const mql = fillMarkers(template(path), {
    FILTER: "",
    AGENT: PROJECT_AGENT,
    ORDER1: `ORDER {key:${order}, sort:desc}`,
    // The adaptor orders by one key; ties on error (often all 0) then fall in
    // arbitrary order, so calls break them here.
    ORDER2: `ORDER {key:[${order},total], sort:[desc,desc]}`,
    LIMIT1: `LIMIT {everytime:${GROUP_CAP}}`,
    LIMIT2: `LIMIT ${limit}`,
  });
  return { path, mql };
}

/**
 * Coverage of a filled stat query: the same text up to its first HVTEXT,
 * regrouped into one row whose `_rows_` is the number of groups the stat
 * query kept and whose `field` is the sum over them.
 */
export function coverageOf(statMql: string, field: string): string {
  const lines = statMql.split("\n");
  const cut = lines.findIndex((l) => l.trim().startsWith("HVTEXT"));
  const head = (cut >= 0 ? lines.slice(0, cut) : lines).join("\n");
  return [
    head,
    'CREATE {key:one, expr:"1"}',
    "DELETE time",
    `GROUP {pk:[one], merge:[${field}]}`,
    `UPDATE {key:${field}, value:sum}`,
  ].join("\n");
}

/**
 * Exact error totals per class, with the template's own aggregation steps
 * (copy time to tt, group per hour, sum, drop time, regroup). Few groups,
 * so nothing is dropped.
 */
export function errorClassTotalsMql(stime: number, etime: number): string {
  const category = etime - stime >= HOURLY_FROM_MS ? "db3_stat_error{h1}" : "db3_stat_error";
  return [
    `CATEGORY ${category}`,
    "FLEXLOAD",
    "CREATE {key:tt, from:time}",
    "GROUP {timeunit:1h, merge:[count], pk:[classHash], last:[tt]}",
    'UPDATE {key:"count", value:sum}',
    "DELETE time",
    "GROUP {merge:[count], pk:[classHash], last:[tt]}",
    'UPDATE {key:"count", value:sum}',
    "ORDER {key:count, sort:desc}",
    "HVTEXT {hash:classHash, key:class, type:error, timefield:tt}",
  ].join("\n");
}
