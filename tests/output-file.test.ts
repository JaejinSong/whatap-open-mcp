import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerYardTools } from '../src/tools/yard.ts';
import { McpServer } from '../src/mcp/server.ts';
import type { WhatapApiClient } from '../src/api/client.ts';
import { checkOutputFile, writeOutput } from '../src/utils/output-file.ts';
import { LocalArgumentError } from '../src/utils/errors.ts';

const T0 = Date.parse('2026-10-10T01:00:00Z');
const S = 5_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outfile-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** n agents reporting every 5 s from T0, `count` times. Server order: by time. */
function series(count: number, agents = 3, from = 0) {
  const rows: Record<string, unknown>[] = [];
  for (let i = from; i < from + count; i++) {
    for (let a = 0; a < agents; a++) rows.push({ time: T0 + i * S, oid: a, oname: `ag${a}`, v: i * 10 + a });
  }
  return rows;
}

/**
 * A fake server that behaves like the measured one: rows in [stime, etime),
 * filled from stime, cut at limit (mid-way through a time if need be).
 */
function setup(all: Record<string, unknown>[]) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const sent: { stime: number; etime: number; limit: number }[] = [];
  const exec = async (_p: number, q: { stime: number; etime: number; limit: number }) => {
    sent.push({ stime: q.stime, etime: q.etime, limit: q.limit });
    return all.filter((r) => (r.time as number) >= q.stime && (r.time as number) < q.etime).slice(0, q.limit);
  };
  const client = {
    executeMxqlText: exec,
    executeMxqlPath: exec,
    executePromql: exec,
    resolveOids: async () => new Map(),
  } as unknown as WhatapApiClient;
  registerYardTools(server, client);
  const call = (args: Record<string, unknown>) =>
    (server as any)._tools.get('whatap_query_data').callback({
      projectCode: 1,
      path: 'v2/app/resp_time_oid',
      timeRange: '5m',
      limit: 100,
      ...args,
    });
  return { sent, call };
}

const text = (r: any) => r.content[0].text as string;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const csvRows = (f: string) => readFileSync(f, 'utf8').trim().split('\n').slice(1);
const keyOf = (line: string) => line.split(',').slice(0, 1).concat(line.split(',')[2]).join('|');

describe('checkOutputFile: rejected before any request', () => {
  it('relative path', () => {
    expect(() => checkOutputFile('out.csv', false)).toThrow(/absolute path/);
  });
  it('unsupported extension', () => {
    expect(() => checkOutputFile(join(dir, 'out.txt'), false)).toThrow(/\.csv or \.jsonl/);
  });
  it('missing directory', () => {
    expect(() => checkOutputFile(join(dir, 'nope', 'out.csv'), false)).toThrow(/does not exist/);
  });
  it('existing file without stime: never started over', () => {
    const f = join(dir, 'out.csv');
    writeFileSync(f, 'time,time_utc,v\n1,x,2\n');
    expect(() => checkOutputFile(f, false)).toThrow(/already exists/);
    expect(readFileSync(f, 'utf8')).toBe('time,time_utc,v\n1,x,2\n');
  });
  it('existing file this tool did not write', () => {
    const f = join(dir, 'notes.csv');
    writeFileSync(f, 'name,phone\nkim,010\n');
    expect(() => checkOutputFile(f, true)).toThrow(/not written by whatap_query_data/);
    const j = join(dir, 'x.jsonl');
    writeFileSync(j, '{"a":1}\n');
    expect(() => checkOutputFile(j, true)).toThrow(/not written/);
  });
  it('all are LocalArgumentError', () => {
    expect(() => checkOutputFile('rel.csv', false)).toThrow(LocalArgumentError);
  });
});

describe('writeOutput: CSV', () => {
  it('new file: time first, ISO time second, then fields in first-seen order', () => {
    const f = join(dir, 'a.csv');
    const s = writeOutput(checkOutputFile(f, false), series(2, 2), T0);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('time,time_utc,oid,oname,v');
    expect(lines[1]).toBe(`${T0},2026-10-10T01:00:00Z,0,ag0,0`);
    expect(s).toMatchObject({ written: 4, replaced: 0, totalRows: 4, distinctTimes: 2, first: T0, last: T0 + S });
  });

  it('continuing replaces rows at or after stime and keeps earlier ones', () => {
    const f = join(dir, 'a.csv');
    // first call cut mid-way through T0+2S: only one of three agents
    writeOutput(checkOutputFile(f, false), series(3).slice(0, 7), T0);
    const s = writeOutput(checkOutputFile(f, true), series(2, 3, 2), T0 + 2 * S);
    expect(s.replaced).toBe(1);
    expect(s.totalRows).toBe(12);
    const keys = csvRows(f).map(keyOf);
    expect(new Set(keys).size).toBe(12);
  });

  it('a new column pads earlier rows with empty cells', () => {
    const f = join(dir, 'a.csv');
    writeOutput(checkOutputFile(f, false), [{ time: T0, v: 1 }], T0);
    writeOutput(checkOutputFile(f, true), [{ time: T0 + S, v: 2, extra: 'x' }], T0 + S);
    const lines = readFileSync(f, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('time,time_utc,v,extra');
    expect(lines[1].split(',')).toHaveLength(4);
    expect(lines[2]).toBe(`${T0 + S},2026-10-10T01:00:05Z,2,x`);
  });

  it('quotes commas, quotes and newlines; objects become JSON', () => {
    const f = join(dir, 'a.csv');
    writeOutput(checkOutputFile(f, false), [{ time: T0, s: 'a,"b"\nc', o: { k: 1 }, n: null }], T0);
    expect(readFileSync(f, 'utf8').split('\n').slice(1).join('\n')).toBe(
      `${T0},2026-10-10T01:00:00Z,"a,""b""\nc","{""k"":1}",\n`
    );
  });

  it('rows without time: written as-is, but cannot continue a file', () => {
    const f = join(dir, 'rank.csv');
    writeOutput(checkOutputFile(f, false), [{ oname: 'a', cnt: 3 }], T0);
    expect(readFileSync(f, 'utf8')).toBe('oname,cnt\na,3\n');
    const g = join(dir, 'g.csv');
    writeOutput(checkOutputFile(g, false), series(1), T0);
    expect(() => writeOutput(checkOutputFile(g, true), [{ oname: 'a' }], T0)).toThrow(/no "time" column/);
    expect(csvRows(g)).toHaveLength(3);
  });

  it('leaves no temp file behind', () => {
    const f = join(dir, 'a.csv');
    writeOutput(checkOutputFile(f, false), series(1), T0);
    expect(readdirSync(dir)).toEqual(['a.csv']);
  });
});

describe('writeOutput: JSONL', () => {
  it('writes one object per line and continues the same way', () => {
    const f = join(dir, 'a.jsonl');
    writeOutput(checkOutputFile(f, false), series(3).slice(0, 7), T0);
    const s = writeOutput(checkOutputFile(f, true), series(2, 3, 2), T0 + 2 * S);
    const objs = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(objs).toHaveLength(12);
    expect(s).toMatchObject({ replaced: 1, totalRows: 12, distinctTimes: 4 });
    expect(new Set(objs.map((o) => `${o.time}|${o.oid}`)).size).toBe(12);
  });
});

describe('query_data with outputFile', () => {
  const stime = iso(T0);
  const etime = iso(T0 + 60 * S); // 60 times × 3 agents = 180 rows

  it('saves rows, returns a summary instead of the table', async () => {
    const { call } = setup(series(60));
    const f = join(dir, 'a.csv');
    const r = text(await call({ stime, etime, limit: 1000, outputFile: f }));
    expect(r).toContain('**Saved**: 180 rows');
    expect(r).toContain('Complete');
    expect(r).not.toContain('| time |');
    expect(r).not.toContain('ag1');
    expect(csvRows(f)).toHaveLength(180);
  });

  it('following the continuation advice collects every row exactly once', async () => {
    for (const limit of [7, 10, 50, 179]) {
      const all = series(60);
      const { call, sent } = setup(all);
      const f = join(dir, `l${limit}.csv`);
      let r = text(await call({ stime, etime, limit, outputFile: f }));
      let guard = 0;
      while (!r.includes('Complete')) {
        const next = r.match(/stime="([^"]+)"/)![1];
        r = text(await call({ stime: next, etime, limit, outputFile: f }));
        if (++guard > 100) throw new Error(`no progress at limit ${limit}`);
      }
      const keys = csvRows(f).map(keyOf);
      expect(keys).toHaveLength(all.length);
      expect(new Set(keys).size).toBe(all.length);
      // stime only moves forward: no repeated request
      const starts = sent.map((s) => s.stime);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });

  it('one time holding more rows than the limit: says raise limit, not the same stime again', async () => {
    const { call } = setup(series(5, 10));
    const r = text(await call({ stime, etime, limit: 4, outputFile: join(dir, 'a.csv') }));
    expect(r).toContain('a limit well above 4');
  });

  it('bad outputFile sends nothing', async () => {
    const { call, sent } = setup(series(5));
    for (const outputFile of ['rel.csv', join(dir, 'a.txt'), join(dir, 'x', 'a.csv')]) {
      const r = await call({ stime, etime, outputFile });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('The request was not sent');
    }
    expect(sent).toHaveLength(0);
  });

  it('existing file without stime sends nothing and is untouched', async () => {
    const { call, sent } = setup(series(5));
    const f = join(dir, 'a.csv');
    writeFileSync(f, 'time,time_utc,v\n1,x,2\n');
    const r = await call({ timeRange: '5m', outputFile: f });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
    expect(readFileSync(f, 'utf8')).toBe('time,time_utc,v\n1,x,2\n');
  });

  it('PromQL with outputFile is rejected before sending', async () => {
    const { call, sent } = setup(series(5));
    const r = await call({ path: undefined, query: 'up', outputFile: join(dir, 'a.csv') });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('MXQL (path) only');
    expect(sent).toHaveLength(0);
  });

  it('no data: no file is created', async () => {
    const { call } = setup([]);
    const f = join(dir, 'a.csv');
    await call({ stime, etime, outputFile: f });
    expect(existsSync(f)).toBe(false);
  });

  it('without outputFile the table response is unchanged', async () => {
    const { call } = setup(series(2));
    const r = text(await call({ stime, etime }));
    expect(r).toContain('ag1');
    expect(r).not.toContain('**Saved**');
  });
});
