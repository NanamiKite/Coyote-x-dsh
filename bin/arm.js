#!/usr/bin/env node
"use strict";
/*
 * 本地武装 CLI —— 唯一能解锁输出工具的入口。
 *
 *   node bin/arm.js on [--minutes 30]   武装（默认 30 分钟，最长 24 小时）
 *   node bin/arm.js off                 立即撤销武装
 *   node bin/arm.js status              查看武装状态
 *
 * MCP server 每次执行前重新读取 arm 文件；
 * AI 只能通过 MCP 工具看到状态摘要，无法调用本 CLI。
 */
const { arm, disarm, armSummary, armFilePath } = require("../src/game/arm");

const [, , command, ...rest] = process.argv;

function parseMinutes(argv) {
  const i = argv.indexOf("--minutes");
  if (i === -1) return undefined;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v)) {
    console.error("--minutes 需要一个数字");
    process.exit(1);
  }
  return v;
}

switch (command) {
  case "on": {
    const payload = arm(parseMinutes(rest));
    console.log("已武装。");
    console.log(`  有效期: ${payload.minutes} 分钟（至 ${new Date(payload.expiresAt).toLocaleString()}）`);
    console.log(`  arm 文件: ${armFilePath()}`);
    console.log("现在 AI 可以执行有界反馈了。到期或 `off` 后自动锁定。");
    break;
  }
  case "off": {
    const removed = disarm();
    console.log(removed ? "已撤销武装，输出工具重新锁定。" : "本来就没有武装。");
    break;
  }
  case "status": {
    const s = armSummary();
    if (s.armed) {
      console.log(`已武装：剩余 ${s.remainingSeconds} 秒（${s.minutes} 分钟档，至 ${new Date(s.expiresAt).toLocaleString()}）`);
    } else {
      console.log(`未武装（${s.reason}）。运行 \`node bin/arm.js on\` 解锁输出工具。`);
    }
    break;
  }
  default:
    console.log("用法: node bin/arm.js <on|off|status> [--minutes N]");
    process.exit(command ? 1 : 0);
}
