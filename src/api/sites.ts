// src/api/sites.ts
// Several WhaTap servers (sites) behind one MCP process. Sites are told apart
// by URL, not by pcode: two servers number their projects independently, so
// the same pcode can mean different projects.
//
// Tools keep taking one WhatapApiClient. They get `routedClient`, which hands
// each call to the client of the site the current tool call runs under
// (`SiteRouter.run`), so no tool needs to know about sites.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Site } from "../config.js";
import { WhatapApiClient } from "./client.js";

export class SiteRouter {
  readonly sites: readonly Site[];
  private readonly clients = new Map<string, WhatapApiClient>();
  private readonly current = new AsyncLocalStorage<WhatapApiClient>();

  constructor(sites: Site[], makeClient: (site: Site) => WhatapApiClient = (s) => new WhatapApiClient(s)) {
    if (sites.length === 0) throw new Error("SiteRouter needs at least one site");
    this.sites = sites;
    for (const s of sites) this.clients.set(s.name, makeClient(s));
  }

  get multi(): boolean {
    return this.sites.length > 1;
  }

  /**
   * Find a site by its configured name, its URL or its host, ignoring case
   * and a trailing slash: `self`, `https://self.whatap.io`, `self.whatap.io`.
   */
  resolve(value: string): Site | undefined {
    const v = value.trim().replace(/\/+$/, "").toLowerCase();
    if (!v) return undefined;
    for (const s of this.sites) {
      const url = s.apiUrl.toLowerCase();
      let host = "";
      try {
        host = new URL(s.apiUrl).host.toLowerCase();
      } catch {
        // apiUrl without a scheme: compare it as given
      }
      if (v === s.name.toLowerCase() || v === url || v === host) return s;
    }
    return undefined;
  }

  /** `service (https://api.whatap.io), self (https://self.whatap.io)` */
  describe(): string {
    return this.sites.map((s) => `${s.name} (${s.apiUrl})`).join(", ");
  }

  clientOf(site: Site): WhatapApiClient {
    return this.clients.get(site.name)!;
  }

  /** Run `fn` with every routedClient call going to `site`. */
  run<T>(site: Site, fn: () => T): T {
    return this.current.run(this.clientOf(site), fn);
  }

  /** The client for the running tool call; the only site's client otherwise. */
  active(): WhatapApiClient {
    const c = this.current.getStore();
    if (c) return c;
    if (!this.multi) return this.clientOf(this.sites[0]);
    throw new Error(`No site selected. Pass site: one of ${this.describe()}.`);
  }

  /** A WhatapApiClient stand-in that forwards each access to `active()`. */
  routedClient(): WhatapApiClient {
    return new Proxy({} as WhatapApiClient, {
      get: (_t, prop) => {
        const c = this.active();
        const v = (c as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(c) : v;
      },
    });
  }
}
