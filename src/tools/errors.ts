// src/tools/errors.ts
// whatap_error_summary — the WhaTap UI's error and outbound-HTTP statistics
// (yard templates mxql/apm/stat/error_stat* and httpc_stat*, markers filled as
// the yard adaptors fill them; see src/yard/stat-adaptors.ts), plus the stack
// of each error where the agent recorded one (ERRORSNAP).
//
// The project API token cannot reach the yard text API, so HVTEXT inside the
// MXQL text endpoint is the only route to readable class, message, service,
// host and URL values; the templates already do that.
//
// Two checks the UI does not make, both measured against production yard
// (2026-10-11):
// - GROUP keeps at most 10,000 groups and drops the rest silently. On the Java
//   demo project a day of errors grouped by class + service + message kept
//   66,494 of 85,093. Each table is compared with an exact total and the
//   response says when it is short.
// - Stacks exist only for real exceptions on Java agents. Agent-generated
//   errors (STATUS_ERROR, HTTPC_ERROR, CONNECTION_OPEN_FAIL) have a snap id
//   and no stack.

import { z } from "../mcp/schema.js";
import type { McpServer } from "../mcp/server.js";
import type { WhatapApiClient } from "../api/client.js";
import type { MxqlResult } from "../api/types.js";
import { parseTimeRange } from "../utils/time.js";
import { PARAM_PROJECT_CODE } from "../utils/descriptions.js";
import {
  classifyAndBuildError,
  appendNextSteps,
  buildServerErrorResponse,
  extractServerError,
} from "../utils/response.js";
import { MXQL_PAGE_KEY } from "../api/client.js";
import {
  GROUP_CAP,
  errorStatQuery,
  httpcStatQuery,
  coverageOf,
  errorClassTotalsMql,
  isHourlyWindow,
} from "../yard/stat-adaptors.js";

/** The server rejects windows of 32 days or more. */
const MAX_WINDOW_MS = 32 * 86_400_000;
/**
 * Ranked errors scanned for stacks. Agent-generated errors have no stack and
 * often fill the top ranks, so stacks are looked up further down than the
 * table shows.
 */
export const STACK_SCAN = 50;
/** The yard runs at most 3 MXQL queries per project at once. */
const CONCURRENCY = 3;

/** ERRORSNAP over the error template's renamed snap id and stat time. */
export const ERRORSNAP_LINE = "ERRORSNAP {snap:snapSeq, key:stack, timefield:tt}";

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Header and footnote for the `tt` column. `tt` is the time of the last stat
 * record a row occurred in, so its unit follows the window: 5-minute records
 * under a day, hourly records from a day on.
 */
export function lastSeenColumn(hourly: boolean): { header: string; note: string } {
  return hourly
    ? { header: "Last hour", note: "Last hour is the start of the last hour the row occurred in (windows of a day or more read hourly statistics)." }
    : { header: "Last 5 min", note: "Last 5 min is the start of the last 5-minute interval the row occurred in (windows under a day read 5-minute statistics)." };
}

type Row = Record<string, unknown>;

function n(row: Row, key: string): number {
  const v = row[key];
  const x = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(x) ? x : 0;
}

function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Escape a value for a markdown table cell. */
function cell(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function iso(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString().replace(".000Z", "Z") : "-";
}

export interface Coverage {
  groups: number;
  covered: number;
}

export function readCoverage(rows: MxqlResult, field: string): Coverage | null {
  const r = rows.find((x) => x && typeof x === "object" && "one" in x) as Row | undefined;
  if (!r) return null;
  return { groups: n(r, "_rows_"), covered: Math.round(n(r, field)) };
}

/**
 * A table is short when the stat query counted less than the exact total,
 * or, without an exact total, when it reached the group cap.
 */
export function coverageNote(cov: Coverage | null, exactTotal: number | null): string | null {
  if (!cov) return "Coverage check returned no row; the table may be incomplete.";
  const short = exactTotal !== null ? cov.covered < Math.round(exactTotal) : cov.groups >= GROUP_CAP;
  if (!short) return null;
  const of = exactTotal !== null ? ` of ${Math.round(exactTotal).toLocaleString()}` : "";
  return (
    `**Incomplete**: the server keeps ${GROUP_CAP.toLocaleString()} groups and dropped the rest ` +
    `(${cov.covered.toLocaleString()}${of} counted in ${cov.groups.toLocaleString()} groups). ` +
    "Counts and ranks below cover only the kept groups; the WhaTap UI statistics screen shows the same cut. " +
    "Narrow the time range for complete rankings."
  );
}

/** Run tasks with at most `limit` in flight, keeping input order. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

// ─── Tool ──────────────────────────────────────────────────────

export function registerErrorTools(server: McpServer, client: WhatapApiClient): void {
  server.tool(
    "whatap_error_summary",
    "APM error and outbound HTTP call statistics with readable text, as the WhaTap UI's " +
      "statistics screens show them: error class, message and service; external host, URL, " +
      "calls, errors and time. Adds the stack trace of errors the agent recorded one for. " +
      "Use this instead of whatap_query_data when you need to know WHICH errors occurred, " +
      "because raw stat categories return only hashes.\n\n" +
      "Stacks: only Java agents record them, and only for real exceptions. Agent-generated " +
      "errors such as STATUS_ERROR(4xx/5xx) and HTTPC_ERROR carry no stack.\n\n" +
      "PREREQUISITES: projectCode from whatap_list_projects (an APM project, or a Kubernetes " +
      "project whose pods run an APM agent).\n\n" +
      'Example: whatap_error_summary(projectCode=12345, timeRange="1h")',
    {
      projectCode: z.number().describe(PARAM_PROJECT_CODE),
      timeRange: z
        .string()
        .default("1h")
        .describe('Time range (default: "1h"). Examples: "30m", "6h", "1d". Must be under 32 days. From 1 day on, hourly statistics are read.'),
      limit: z
        .number()
        .default(20)
        .describe("Rows per table (default 20, max 100)."),
      stackLines: z
        .number()
        .default(15)
        .describe("Stack lines shown per error (default 15, 0 = no stacks). Stacks are shown for up to 5 errors."),
    },
    async ({ projectCode, timeRange, limit, stackLines }) => {
      const tool = "whatap_error_summary";
      try {
        const { stime, etime } = parseTimeRange(timeRange);
        if (etime - stime >= MAX_WINDOW_MS) {
          return {
            content: [{ type: "text" as const, text: `**Rejected before sending**: the server refuses windows of 32 days or more (got "${timeRange}").` }],
            isError: true,
          };
        }
        const top = Math.max(1, Math.min(100, Math.floor(limit)));
        const withStack = stackLines > 0;
        const err = errorStatQuery(stime, etime, withStack ? Math.max(top, STACK_SCAN) : top);
        const httpc = httpcStatQuery(stime, etime, top);
        const last = lastSeenColumn(isHourlyWindow(stime, etime));
        const queries = {
          errClass: errorClassTotalsMql(stime, etime),
          errStat: withStack ? `${err.mql}\n${ERRORSNAP_LINE}` : err.mql,
          errCov: coverageOf(err.mql, "count"),
          httpcStat: httpc.mql,
          httpcCov: coverageOf(httpc.mql, "httpc_count"),
        };
        const names = Object.keys(queries) as (keyof typeof queries)[];
        const settled = await pool(
          names.map((k) => () =>
            client.executeMxqlText(projectCode, { stime, etime, mql: queries[k], limit: 100_000 })
          ),
          CONCURRENCY
        );
        const res = {} as Record<keyof typeof queries, MxqlResult>;
        for (let i = 0; i < names.length; i++) {
          const r = settled[i];
          if (r.status === "rejected") throw r.reason;
          const serverError = extractServerError(r.value);
          if (serverError !== null) {
            return buildServerErrorResponse({
              toolName: tool,
              serverMessage: serverError,
              projectCode,
              timeRange,
              echo: {
                endpoint: "mxql/text",
                sentMql: queries[names[i]],
                serverExpanded: false,
                stime,
                etime,
                limit: 100_000,
                pageKey: MXQL_PAGE_KEY,
                rawRowCount: r.value.length,
                dataRowCount: 0,
              },
            });
          }
          res[names[i]] = r.value;
        }

        const classRows = res.errClass as Row[];
        const errTotal = classRows.reduce((a, r) => a + n(r, "count"), 0);
        const ranked = res.errStat as Row[];
        const detail = ranked.slice(0, top);
        const httpcRows = res.httpcStat as Row[];

        const lines: string[] = [
          `## Error Summary — Project ${projectCode}`,
          "",
          `**Window**: ${iso(stime)} → ${iso(etime)} (${timeRange}) | **Errors**: ${Math.round(errTotal).toLocaleString()} | **Error classes**: ${classRows.length}`,
          `**Source**: \`${err.path}\` and \`${httpc.path}\`, the queries behind the WhaTap UI statistics screens.`,
          "",
        ];

        if (classRows.length === 0 && httpcRows.length === 0) {
          lines.push(
            "**No error or outbound HTTP rows.** The server reported no error, so this does not show " +
              "the application is healthy. Consistent with it, none confirmed here: no APM agent in this " +
              "project, no traffic in the window, or agents not reporting. " +
              `Check \`whatap_list_agents(projectCode=${projectCode})\`.`
          );
          return { content: [{ type: "text" as const, text: appendNextSteps(lines.join("\n"), tool) }] };
        }

        if (classRows.length > 0) {
          lines.push("### Errors by class (exact totals)", "", `| Class | Count | ${last.header} |`, "| --- | ---: | --- |");
          for (const r of classRows.slice(0, top)) {
            lines.push(`| ${cell(s(r, "class") || `hash ${n(r, "classHash")}`)} | ${Math.round(n(r, "count")).toLocaleString()} | ${iso(n(r, "tt"))} |`);
          }
          if (classRows.length > top) lines.push("", `${classRows.length - top} more classes not shown.`);
          lines.push("");

          lines.push(
            "### Top errors (class + service + message)",
            "",
            `| # | Class | Message | Service | Count | ${last.header} |`,
            "| ---: | --- | --- | --- | ---: | --- |"
          );
          detail.forEach((r, i) => {
            lines.push(
              `| ${i + 1} | ${cell(s(r, "class"), 80)} | ${cell(s(r, "msg"), 100)} | ${cell(s(r, "service") || "-", 80)} | ${Math.round(n(r, "count")).toLocaleString()} | ${iso(n(r, "tt"))} |`
            );
          });
          const note = coverageNote(readCoverage(res.errCov, "count"), errTotal);
          if (note) lines.push("", note);
          lines.push(
            "",
            `A blank service means the error happened outside a traced transaction or its text was not found. ${last.note}`
          );
          lines.push("");

          if (withStack) {
            const stacked = ranked.filter((r) => s(r, "stack").trim() !== "").slice(0, 5);
            lines.push(
              "### Stacks",
              "",
              `Most frequent errors that have a recorded stack, from the top ${ranked.length} above ` +
                "(rank shown). Each stack is from the last occurrence.",
              ""
            );
            if (stacked.length === 0) {
              lines.push(
                `None of the top ${ranked.length} errors has a recorded stack. Only Java agents record stacks, and ` +
                  "agent-generated errors (STATUS_ERROR, HTTPC_ERROR) have none.",
                ""
              );
            }
            for (const r of stacked) {
              const idx = ranked.indexOf(r) + 1;
              const st = s(r, "stack").split("\n").filter((x) => x.trim() !== "");
              lines.push(
                `**#${idx} ${cell(s(r, "class"), 80)}**: ${cell(s(r, "msg"), 160)} ` +
                  `(${Math.round(n(r, "count")).toLocaleString()} times, service ${cell(s(r, "service") || "-", 80)}, ${st.length} frames)`,
                "",
                "```"
              );
              lines.push(...st.slice(0, stackLines));
              if (st.length > stackLines) lines.push(`... ${st.length - stackLines} more frames`);
              lines.push("```", "");
            }
          }
        }

        lines.push("### Outbound HTTP calls (most errors first, then most calls)", "");
        if (httpcRows.length === 0) {
          lines.push("No outbound HTTP call rows in this window.");
        } else {
          lines.push(
            `| Host | Port | URL | Calls | Errors | Avg | Max | Last caller service | ${last.header} |`,
            "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |"
          );
          for (const r of httpcRows) {
            lines.push(
              `| ${cell(s(r, "host") || `hash ${n(r, "hostHash")}`, 60)} | ${n(r, "port") || "-"} | ${cell(s(r, "url") || `hash ${n(r, "urlHash")}`, 100)} | ` +
                `${Math.round(n(r, "total")).toLocaleString()} | ${Math.round(n(r, "error")).toLocaleString()} | ${Math.round(n(r, "avg"))}ms | ${Math.round(n(r, "max"))}ms | ` +
                `${cell(s(r, "service") || "-", 60)} | ${iso(n(r, "tt"))} |`
            );
          }
          lines.push("", last.note);
          const note = coverageNote(readCoverage(res.httpcCov, "httpc_count"), null);
          if (note) lines.push("", note);
        }

        return { content: [{ type: "text" as const, text: appendNextSteps(lines.join("\n"), tool) }] };
      } catch (err) {
        return classifyAndBuildError(err, { toolName: tool, projectCode, timeRange });
      }
    }
  );
}
