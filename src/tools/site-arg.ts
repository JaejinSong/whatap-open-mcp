// src/tools/site-arg.ts
// With more than one site configured, every tool takes a required `site`
// (name, URL or host) and runs against that site's client. The only exception
// is whatap_list_projects, which lists every site when `site` is left out.
// With one site nothing changes: no `site` argument, no label.

import { z } from "../mcp/schema.js";
import type { McpServer, RegisteredTool } from "../mcp/server.js";
import type { McpToolResult } from "../mcp/types.js";
import type { Site } from "../config.js";
import type { SiteRouter } from "../api/sites.js";

const LIST_TOOL = "whatap_list_projects";

function text(result: McpToolResult): string {
  return result.content
    .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

function siteLabel(site: Site): string {
  return `*Site: ${site.name} (${site.apiUrl})*`;
}

/** Put the site on the first line so every answer says where it came from. */
function labelResult(result: McpToolResult, site: Site): McpToolResult {
  const [first, ...rest] = result.content;
  if (first && "text" in first && typeof first.text === "string") {
    return { ...result, content: [{ ...first, text: `${siteLabel(site)}\n\n${first.text}` }, ...rest] };
  }
  return { ...result, content: [{ type: "text" as const, text: siteLabel(site) }, ...result.content] };
}

export function addSiteArgument(server: McpServer, router: SiteRouter): void {
  if (!router.multi) return;

  const desc =
    `WhaTap server to query, by name or URL: ${router.describe()}. ` +
    "Servers number projects independently, so a projectCode from one server means a different project on another.";

  server.wrapTools((tool: RegisteredTool): RegisteredTool => {
    const listAll = tool.name === LIST_TOOL;
    const node = listAll
      ? z.string().optional().describe(`${desc} Omit to list projects on every server.`)
      : z.string().describe(desc);

    const callback = async (args: Record<string, unknown>): Promise<McpToolResult> => {
      const { site, ...rest } = args;

      if (site === undefined && listAll) {
        const parts = await Promise.all(
          router.sites.map(async (s) => {
            const r = await router.run(s, () => tool.callback(rest));
            return { r, s };
          })
        );
        return {
          content: [
            {
              type: "text" as const,
              text: parts.map(({ r, s }) => `# ${s.name} (${s.apiUrl})\n\n${text(r)}`).join("\n\n"),
            },
          ],
          ...(parts.every(({ r }) => r.isError) ? { isError: true } : {}),
        };
      }

      const s = router.resolve(String(site ?? ""));
      if (!s) {
        return {
          content: [{ type: "text" as const, text: `Unknown site "${String(site)}". Use one of: ${router.describe()}.` }],
          isError: true,
        };
      }
      return labelResult(await router.run(s, () => tool.callback(rest)), s);
    };

    return {
      ...tool,
      inputSchema: { ...(tool.inputSchema ?? {}), site: node },
      callback,
    };
  });
}
