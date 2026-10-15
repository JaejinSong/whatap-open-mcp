import { describe, it, expect } from 'vitest';
import { readCoverage, coverageNote, lastSeenColumn } from '../src/tools/errors.ts';
import { fillMarkers, scanMarkers } from '../src/yard/markers.ts';
import {
  GROUP_CAP,
  errorStatQuery,
  httpcStatQuery,
  coverageOf,
  errorClassTotalsMql,
  isHourlyWindow,
} from '../src/yard/stat-adaptors.ts';

const HOUR = 3_600_000;
const NOW = 1_791_726_600_000;

describe('fillMarkers', () => {
  it('fills spaced and unspaced markers', () => {
    expect(fillMarkers('A\n<% AGENT %>\n<%LIMIT2%>', { AGENT: 'OIDSET {oid:[1]}', LIMIT2: 'LIMIT 5' }))
      .toBe('A\nOIDSET {oid:[1]}\nLIMIT 5');
  });

  it('refuses to leave a marker unfilled', () => {
    expect(() => fillMarkers('<% AGENT %>\n<% FILTER %>', { AGENT: '' })).toThrow(/FILTER/);
  });
});

describe('stat adaptors', () => {
  it('reads the 5-minute template under a day and the hourly one from a day on', () => {
    expect(errorStatQuery(NOW - HOUR, NOW, 20).path).toBe('mxql/apm/stat/error_stat');
    expect(errorStatQuery(NOW - 24 * HOUR, NOW, 20).path).toBe('mxql/apm/stat/error_stat_1h');
    expect(httpcStatQuery(NOW - HOUR, NOW, 20).path).toBe('mxql/apm/stat/httpc_stat');
    expect(httpcStatQuery(NOW - 24 * HOUR, NOW, 20).path).toBe('mxql/apm/stat/httpc_stat_1h');
  });

  it('leaves no marker in any filled template', () => {
    for (const w of [HOUR, 24 * HOUR]) {
      for (const q of [errorStatQuery(NOW - w, NOW, 20), httpcStatQuery(NOW - w, NOW, 20)]) {
        expect(scanMarkers(q.mql).hasMarkers).toBe(false);
      }
    }
  });

  it('takes the caller row count only at LIMIT2, not the per-hour LIMIT1', () => {
    const q = errorStatQuery(NOW - HOUR, NOW, 20).mql;
    expect(q).toContain(`LIMIT {everytime:${GROUP_CAP}}`);
    expect(q).toContain('LIMIT 20');
    expect(q).not.toContain('LIMIT {everytime:20}');
  });

  it('orders outbound calls by errors, then calls', () => {
    expect(httpcStatQuery(NOW - HOUR, NOW, 5).mql).toContain('ORDER {key:[error,total], sort:[desc,desc]}');
  });

  it('cuts coverage before the text lookups and regroups into one row', () => {
    const cov = coverageOf(errorStatQuery(NOW - HOUR, NOW, 20).mql, 'count');
    expect(cov).not.toContain('HVTEXT');
    expect(cov).toMatch(/GROUP \{pk:\[one\], merge:\[count\]\}\nUPDATE \{key:count, value:sum\}$/);
  });

  it('totals classes with the templates\' documented steps, not timeunit:whole', () => {
    const q = errorClassTotalsMql(NOW - HOUR, NOW);
    expect(q).toContain('DELETE time');
    expect(q).not.toContain('timeunit:whole');
    expect(errorClassTotalsMql(NOW - 24 * HOUR, NOW)).toContain('db3_stat_error{h1}');
  });
});

describe('coverage note', () => {
  it('reads group count and covered sum', () => {
    expect(readCoverage([{ one: 1, count: 66494, _rows_: 10000 }], 'count')).toEqual({ groups: 10000, covered: 66494 });
  });

  it('flags a table that counted less than the exact total', () => {
    expect(coverageNote({ groups: GROUP_CAP, covered: 66494 }, 85093)).toMatch(/Incomplete/);
  });

  it('stays silent when the counts match', () => {
    expect(coverageNote({ groups: 410, covered: 576 }, 576)).toBeNull();
  });

  it('falls back to the group cap without an exact total', () => {
    expect(coverageNote({ groups: 6480, covered: 4963458 }, null)).toBeNull();
    expect(coverageNote({ groups: GROUP_CAP, covered: 1 }, null)).toMatch(/Incomplete/);
  });

  it('says so when the check returned nothing', () => {
    expect(coverageNote(readCoverage([], 'count'), null)).toMatch(/may be incomplete/);
  });
});

describe('last-seen column', () => {
  it('names the 5-minute unit under a day and the hour from a day on', () => {
    expect(isHourlyWindow(NOW - HOUR, NOW)).toBe(false);
    expect(isHourlyWindow(NOW - 24 * HOUR, NOW)).toBe(true);
    expect(lastSeenColumn(false).header).toBe('Last 5 min');
    expect(lastSeenColumn(true).header).toBe('Last hour');
  });
});
