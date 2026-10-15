import { McpServer } from "./mcp/server.js";
import { StdioTransport } from "./mcp/transport.js";
import { loadSites } from "./config.js";
import { SiteRouter } from "./api/sites.js";
import { registerAllTools } from "./tools/index.js";
import { addSiteArgument } from "./tools/site-arg.js";
import { VERSION } from "./version.js";

export { VERSION };

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`whatap-mcp ${VERSION}`);
  process.exit(0);
}

async function main() {
  const router = new SiteRouter(loadSites());

  const server = new McpServer({
    name: "whatap-mcp",
    version: VERSION,
  });

  addSiteArgument(server, router);
  registerAllTools(server, router.routedClient());

  const transport = new StdioTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start WhaTap MCP server:", err);
  process.exit(1);
});
