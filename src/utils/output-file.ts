import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute } from "node:path";
import { LocalArgumentError } from "./errors.js";

/**
 * Saves query_data rows to a file instead of returning them as a table.
 *
 * One tool call is still one request: a truncated result is continued by
 * calling again with the same file and the stime the response gives. Rows in
 * the file at or after that stime are replaced by the new rows, which is the
 * rule measured to lose nothing at the boundary (2026-10-11): the server fills
 * from stime, and rows at the latest returned time may be partial.
 */

export type OutputFormat = "csv" | "jsonl";

export interface OutputTarget {
  path: string;
  format: OutputFormat;
  /** The file exists and will be continued from stime. */
  continuing: boolean;
}

export interface OutputSummary {
  written: number;
  /** Rows already in the file at or after stime, replaced by this call. */
  replaced: number;
  totalRows: number;
  distinctTimes: number;
  first?: number;
  last?: number;
  columns: string[];
}

const TIME = "time";
const TIME_UTC = "time_utc";

/**
 * Validates outputFile before any request is sent. An existing file is only
 * ever continued, and only when stime says where from.
 */
export function checkOutputFile(file: string, hasStime: boolean): OutputTarget {
  if (!isAbsolute(file)) {
    throw new LocalArgumentError(
      `outputFile must be an absolute path, got "${file}".`
    );
  }
  const ext = extname(file).toLowerCase();
  if (ext !== ".csv" && ext !== ".jsonl") {
    throw new LocalArgumentError(
      `outputFile must end in .csv or .jsonl, got "${file}".`
    );
  }
  const dir = dirname(file);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new LocalArgumentError(`outputFile directory does not exist: ${dir}`);
  }
  const format: OutputFormat = ext === ".csv" ? "csv" : "jsonl";
  if (!existsSync(file)) return { path: file, format, continuing: false };

  if (!hasStime) {
    throw new LocalArgumentError(
      `outputFile ${file} already exists. To continue it, pass the stime the previous ` +
        `response gave (same etime). To start a new collection, choose a new path.`
    );
  }
  if (!looksWritten(file, format)) {
    throw new LocalArgumentError(
      `outputFile ${file} exists but was not written by whatap_query_data ` +
        `(no "${TIME}" column), so it cannot be continued. Choose a new path.`
    );
  }
  return { path: file, format, continuing: true };
}

function looksWritten(file: string, format: OutputFormat): boolean {
  const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
  if (format === "csv") return firstLine.split(",")[0] === TIME;
  try {
    return typeof JSON.parse(firstLine)?.[TIME] === "number";
  } catch {
    return false;
  }
}

/** Writes rows to the target, replacing rows at or after stime when continuing. */
export function writeOutput(
  target: OutputTarget,
  rows: Record<string, unknown>[],
  stime: number
): OutputSummary {
  const timed = rows.some((r) => typeof r[TIME] === "number");
  if (target.continuing && !timed) {
    throw new LocalArgumentError(
      `This result has no "${TIME}" column, so it cannot continue ${target.path}. ` +
        `Choose a new path.`
    );
  }
  const out =
    target.format === "csv"
      ? writeCsv(target, rows, stime, timed)
      : writeJsonl(target, rows, stime);
  return { ...out, written: rows.length };
}

function writeCsv(
  target: OutputTarget,
  rows: Record<string, unknown>[],
  stime: number,
  timed: boolean
): Omit<OutputSummary, "written"> {
  let columns: string[] = [];
  let kept: string[] = [];
  let replaced = 0;
  const times: number[] = [];

  if (target.continuing) {
    const lines = readFileSync(target.path, "utf8").split("\n").filter((l) => l !== "");
    columns = lines[0].split(",");
    for (const line of lines.slice(1)) {
      // time is always the first column and never quoted.
      const t = Number(line.slice(0, line.indexOf(",")));
      if (t >= stime) {
        replaced++;
      } else {
        kept.push(line);
        times.push(t);
      }
    }
  } else if (timed) {
    columns = [TIME, TIME_UTC];
  }

  const known = new Set(columns);
  const added: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        known.add(key);
        added.push(key);
      }
    }
  }
  if (added.length > 0) {
    // Header names are plain field names; earlier rows get empty cells.
    const pad = ",".repeat(added.length);
    kept = kept.map((l) => l + pad);
    columns = columns.concat(added);
  }

  const body = rows.map((row) => {
    const t = row[TIME];
    if (typeof t === "number") times.push(t);
    return columns
      .map((c) =>
        c === TIME_UTC && timed
          ? typeof t === "number" ? isoTime(t) : ""
          : csvCell(row[c])
      )
      .join(",");
  });

  atomicWrite(target.path, [columns.join(","), ...kept, ...body].join("\n") + "\n");
  return { replaced, totalRows: kept.length + body.length, columns, ...timeStats(times) };
}

function writeJsonl(
  target: OutputTarget,
  rows: Record<string, unknown>[],
  stime: number
): Omit<OutputSummary, "written"> {
  const kept: string[] = [];
  let replaced = 0;
  const times: number[] = [];
  const columns = new Set<string>();

  if (target.continuing) {
    for (const line of readFileSync(target.path, "utf8").split("\n")) {
      if (line === "") continue;
      const obj = JSON.parse(line) as Record<string, unknown>;
      const t = obj[TIME];
      if (typeof t === "number" && t >= stime) {
        replaced++;
        continue;
      }
      kept.push(line);
      if (typeof t === "number") times.push(t);
      for (const k of Object.keys(obj)) columns.add(k);
    }
  }
  const body = rows.map((row) => {
    const t = row[TIME];
    if (typeof t === "number") times.push(t);
    for (const k of Object.keys(row)) columns.add(k);
    return JSON.stringify(row);
  });

  atomicWrite(target.path, [...kept, ...body].join("\n") + "\n");
  return {
    replaced,
    totalRows: kept.length + body.length,
    columns: [...columns],
    ...timeStats(times),
  };
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timeStats(times: number[]): Pick<OutputSummary, "distinctTimes" | "first" | "last"> {
  if (times.length === 0) return { distinctTimes: 0 };
  let first = Infinity;
  let last = -Infinity;
  for (const t of times) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  return { distinctTimes: new Set(times).size, first, last };
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}
