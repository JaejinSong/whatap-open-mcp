import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadSites, SINGLE_SITE } from '../src/config.ts';
import { SiteRouter } from '../src/api/sites.ts';
import { WhatapApiClient, USER_AGENT } from '../src/api/client.ts';
import { McpServer } from '../src/mcp/server.ts';
import { z, shapeToJsonSchema } from '../src/mcp/schema.ts';
import { addSiteArgument } from '../src/tools/site-arg.ts';
import { registerAllTools } from '../src/tools/index.ts';

const TWO = {
  WHATAP_SITES: 'service=https://api.whatap.io, self=https://self.whatap.io/',
  WHATAP_SERVICE_API_TOKEN: 'tok-service',
  WHATAP_SELF_API_TOKEN: 'tok-self',
};

describe('loadSites', () => {
  it('keeps the single-site setup when WHATAP_SITES is unset', () => {
    expect(loadSites({ WHATAP_API_TOKEN: 't', WHATAP_API_URL: 'https://self.whatap.io/' })).toEqual([
      { name: SINGLE_SITE, apiToken: 't', apiUrl: 'https://self.whatap.io' },
    ]);
  });

  it('reads name=url pairs and per-site tokens', () => {
    expect(loadSites(TWO)).toEqual([
      { name: 'service', apiToken: 'tok-service', apiUrl: 'https://api.whatap.io' },
      { name: 'self', apiToken: 'tok-self', apiUrl: 'https://self.whatap.io' },
    ]);
  });

  it('takes the URL from WHATAP_<NAME>_API_URL, then the default', () => {
    const sites = loadSites({
      WHATAP_SITES: 'saas,on-prem',
      WHATAP_SAAS_API_TOKEN: 'a',
      WHATAP_ON_PREM_API_TOKEN: 'b',
      WHATAP_ON_PREM_API_URL: 'http://10.0.0.5:8080',
    });
    expect(sites.map((s) => s.apiUrl)).toEqual(['https://api.whatap.io', 'http://10.0.0.5:8080']);
  });

  it('serves more than two sites', () => {
    const sites = loadSites({
      WHATAP_SITES: 'a=https://a.example,b=https://b.example,c=https://c.example',
      WHATAP_A_API_TOKEN: '1',
      WHATAP_B_API_TOKEN: '2',
      WHATAP_C_API_TOKEN: '3',
    });
    expect(sites.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });

  it('names the missing token variable', () => {
    expect(() => loadSites({ WHATAP_SITES: 'service,self', WHATAP_SERVICE_API_TOKEN: 'x' })).toThrow(
      /WHATAP_SELF_API_TOKEN/
    );
  });

  it('refuses two sites on one URL, a repeated name, and a bad name', () => {
    expect(() =>
      loadSites({ WHATAP_SITES: 'a,b', WHATAP_A_API_TOKEN: '1', WHATAP_B_API_TOKEN: '2' })
    ).toThrow(/two sites point at/);
    expect(() => loadSites({ ...TWO, WHATAP_SITES: 'self=https://x,SELF=https://y' })).toThrow(/listed twice/);
    expect(() => loadSites({ WHATAP_SITES: '9x=https://x', WHATAP_9X_API_TOKEN: '1' })).toThrow(/valid site name/);
  });
});

function fakeRouter() {
  const sites = loadSites(TWO);
  return new SiteRouter(sites, (s) => ({ tag: s.name } as unknown as WhatapApiClient));
}

describe('SiteRouter.resolve', () => {
  it('finds a site by name, URL or host, ignoring case and a trailing slash', () => {
    const r = fakeRouter();
    for (const v of ['self', 'SELF', 'https://self.whatap.io', 'https://self.whatap.io/', 'self.whatap.io']) {
      expect(r.resolve(v)?.name).toBe('self');
    }
    expect(r.resolve('api.whatap.io')?.name).toBe('service');
    expect(r.resolve('whatap')).toBeUndefined();
  });
});

function echoTool(server: McpServer, client: WhatapApiClient) {
  server.tool('t', 'd', { projectCode: z.number() }, async ({ projectCode }) => ({
    content: [{ type: 'text' as const, text: `${(client as unknown as { tag: string }).tag}:${projectCode}` }],
  }));
  server.tool('whatap_list_projects', 'd', {}, async () => ({
    content: [{ type: 'text' as const, text: `projects of ${(client as unknown as { tag: string }).tag}` }],
  }));
}

function tools(server: McpServer) {
  return (server as unknown as { _tools: Map<string, { inputSchema: Record<string, never>; callback: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._tools;
}

describe('site argument', () => {
  it('adds nothing with one site', () => {
    const r = new SiteRouter(loadSites({ WHATAP_API_TOKEN: 't' }), (s) => ({ tag: s.name } as unknown as WhatapApiClient));
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, r);
    echoTool(server, r.routedClient());
    expect(Object.keys(tools(server).get('t')!.inputSchema)).toEqual(['projectCode']);
  });

  it('requires site on every tool except the project list', () => {
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, fakeRouter());
    echoTool(server, fakeRouter().routedClient());
    expect(shapeToJsonSchema(tools(server).get('t')!.inputSchema).required).toEqual(['projectCode', 'site']);
    expect(shapeToJsonSchema(tools(server).get('whatap_list_projects')!.inputSchema).required).toBeUndefined();
  });

  it('runs each call against the named site and labels the answer', async () => {
    const r = fakeRouter();
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, r);
    echoTool(server, r.routedClient());
    const t = tools(server).get('t')!;
    const [a, b] = await Promise.all([
      t.callback({ projectCode: 1, site: 'self.whatap.io' }),
      t.callback({ projectCode: 1, site: 'service' }),
    ]);
    expect(a.content[0].text).toBe('*Site: self (https://self.whatap.io)*\n\nself:1');
    expect(b.content[0].text).toMatch(/service:1$/);
  });

  it('rejects an unknown site with the list of sites', async () => {
    const r = fakeRouter();
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, r);
    echoTool(server, r.routedClient());
    const res = await tools(server).get('t')!.callback({ projectCode: 1, site: 'whatap' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('service (https://api.whatap.io), self (https://self.whatap.io)');
  });

  it('lists projects on every site when site is left out', async () => {
    const r = fakeRouter();
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, r);
    echoTool(server, r.routedClient());
    const res = await tools(server).get('whatap_list_projects')!.callback({});
    expect(res.content[0].text).toBe(
      '# service (https://api.whatap.io)\n\nprojects of service\n\n# self (https://self.whatap.io)\n\nprojects of self'
    );
  });

  it('keeps all 11 real tools and gives each a site argument', () => {
    const r = fakeRouter();
    const server = new McpServer({ name: 't', version: '0' });
    addSiteArgument(server, r);
    registerAllTools(server, r.routedClient());
    expect(tools(server).size).toBe(11);
    for (const t of tools(server).values()) expect(Object.keys(t.inputSchema)).toContain('site');
  });
});

describe('User-Agent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the MCP on account and project requests', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['User-Agent']);
      return new Response(JSON.stringify({ data: [{ projectCode: 7, apiToken: 'p' }] }), { status: 200 });
    }));
    const c = new WhatapApiClient({ apiToken: 'a', apiUrl: 'http://x' });
    await c.listProjects();
    await c.getProjectInfo(7);
    expect(seen).toEqual([USER_AGENT, USER_AGENT]);
    expect(USER_AGENT).toMatch(/^whatap-mcp\/\d+\.\d+\.\d+$/);
  });
});

describe('same pcode on two servers', () => {
  it('keeps saved PromQL queries apart per server', async () => {
    const { getPromqlQueryStore } = await import('../src/tools/promql.ts');
    const store = getPromqlQueryStore();
    const q = (query: string) => ({
      name: 'cpu', description: '', query, projectCode: 1, metricType: '', createdAt: '', lastUsed: '',
    });
    store.save('https://self.whatap.io', q('self-query'));
    store.save('https://api.whatap.io', q('service-query'));
    expect(store.get('https://self.whatap.io', 1, 'cpu')?.query).toBe('self-query');
    expect(store.get('https://api.whatap.io', 1, 'cpu')?.query).toBe('service-query');
    expect(store.listForProject('https://self.whatap.io', 1).map((x) => x.query)).toEqual(['self-query']);
    expect(store.get('https://other.example', 1, 'cpu')).toBeUndefined();
  });

  it('gives each server its own project token cache', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push(`${new URL(u).host} ${h['x-whatap-token']}`);
      const tok = new URL(u).host.startsWith('self') ? 'p-self' : 'p-service';
      return new Response(JSON.stringify({ data: [{ projectCode: 1, apiToken: tok }] }), { status: 200 });
    }));
    try {
      const r = new SiteRouter(loadSites(TWO));
      const c = r.routedClient();
      for (const name of ['self', 'service', 'self']) {
        await r.run(r.resolve(name)!, () => c.getProjectInfo(1));
      }
      expect(calls.filter((x) => !x.includes(' tok-'))).toEqual([
        'self.whatap.io p-self',
        'api.whatap.io p-service',
        'self.whatap.io p-self',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
