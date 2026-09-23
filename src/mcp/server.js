"use strict";
/*
 * stdio MCP server —— 非 DSH 宿主（Codex / Claude Code 等）的入口。
 *
 * stdout 只承载 MCP 协议消息；日志一律走 stderr。
 * 全部工具语义委托给 src/game/session.js（与 DSH 进程内插件共用）。
 *
 * DeepSeek Harness 推荐用进程内 bundle 插件（src/plugin/index.mjs，
 * 见 README「安装」），本文件保留给其他 MCP 客户端。
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const { createSession } = require("../game/session");

function createServer() {
  const session = createSession();
  const { tools, dispatch, instructions, shutdown } = session;
  const log = (...args) => console.error("[tentacle-mcp]", ...args);

  const server = new Server(
    { name: "tentacle-text-adventure", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      // 工具存在性与参数白名单检查由 session.dispatch 统一执行。
      const result = await dispatch(params.name, params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  });

  return { server, shutdown, session };
}

async function main() {
  const { server, shutdown } = createServer();
  const transport = new StdioServerTransport();
  const cleanup = async (code) => {
    await shutdown();
    process.exit(code);
  };
  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.stdin.on("end", () => cleanup(0));
  process.stdin.on("close", () => cleanup(0));
  await server.connect(transport);
  log("ready (backend=" + (process.env.TENTACLE_BACKEND === "mock" ? "mock" : "ble") + ")");
}

if (require.main === module) {
  main().catch(e => {
    console.error("[tentacle-mcp] fatal:", e.message);
    process.exitCode = 1;
  });
}

module.exports = { createServer };
