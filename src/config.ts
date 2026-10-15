export interface Config {
  apiToken: string;
  apiUrl: string;
}

/** One WhaTap server the MCP can query, told apart by its URL. */
export interface Site extends Config {
  /** Name the caller passes as `site` (from WHATAP_SITES). */
  name: string;
}

export const DEFAULT_API_URL = "https://api.whatap.io";
/** Name of the only site when WHATAP_SITES is not set. Never shown to callers. */
export const SINGLE_SITE = "default";

const SITE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** `self-hosted` → `WHATAP_SELF_HOSTED_API_TOKEN` */
export function siteEnvKey(name: string, suffix: "API_TOKEN" | "API_URL"): string {
  return `WHATAP_${name.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.WHATAP_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "WHATAP_API_TOKEN environment variable is required. " +
        "Set it to your WhaTap account API token."
    );
  }

  const apiUrl = trimUrl(env.WHATAP_API_URL || DEFAULT_API_URL);

  return { apiToken, apiUrl };
}

/**
 * Sites to serve. With WHATAP_SITES unset this is the single site from
 * WHATAP_API_TOKEN / WHATAP_API_URL, as before.
 *
 *   WHATAP_SITES=service=https://api.whatap.io,self=https://self.whatap.io
 *   WHATAP_SERVICE_API_TOKEN=...
 *   WHATAP_SELF_API_TOKEN=...
 *
 * A name without `=url` takes WHATAP_<NAME>_API_URL, then the default URL.
 */
export function loadSites(env: NodeJS.ProcessEnv = process.env): Site[] {
  const spec = env.WHATAP_SITES?.trim();
  if (!spec) return [{ name: SINGLE_SITE, ...loadConfig(env) }];

  const sites: Site[] = [];
  const problems: string[] = [];
  for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const name = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    const inlineUrl = eq >= 0 ? entry.slice(eq + 1).trim() : "";

    if (!SITE_NAME_RE.test(name)) {
      problems.push(`"${name}" is not a valid site name (letters, digits, - and _, starting with a letter)`);
      continue;
    }
    if (sites.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`site "${name}" is listed twice`);
      continue;
    }
    const tokenKey = siteEnvKey(name, "API_TOKEN");
    const apiToken = env[tokenKey];
    if (!apiToken) {
      problems.push(`${tokenKey} is not set for site "${name}"`);
      continue;
    }
    const apiUrl = trimUrl(inlineUrl || env[siteEnvKey(name, "API_URL")] || DEFAULT_API_URL);
    sites.push({ name, apiToken, apiUrl });
  }

  if (problems.length > 0) {
    throw new Error(`WHATAP_SITES: ${problems.join("; ")}`);
  }
  if (sites.length === 0) {
    throw new Error("WHATAP_SITES is set but names no site.");
  }
  const urls = new Set<string>();
  for (const s of sites) {
    if (urls.has(s.apiUrl)) {
      throw new Error(`WHATAP_SITES: two sites point at ${s.apiUrl}; each site needs its own URL.`);
    }
    urls.add(s.apiUrl);
  }
  return sites;
}
