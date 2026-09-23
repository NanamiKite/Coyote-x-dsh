"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/*
 * 本地武装（arm）。
 *
 * 模型：输出工具默认锁定。用户在设备所在电脑运行
 * `node bin/arm.js on [--minutes N]` 后写入 arm 文件；
 * MCP server / 进程内插件每次执行前重新读取该文件。
 *
 * 安全性质：
 *   - arm 文件路径由本地环境变量/用户主目录决定，AI 无法通过 MCP 工具写入；
 *     AI 的文件写入被沙箱限制在工作区，用户主目录默认不可写；
 *   - 每次 arm 生成随机 nonce，server 记录已见 nonce，
 *     防止「读到状态后再补 arm」的竞态被当成持续授权；
 *   - 到期（默认 30 分钟）自动失效；
 *   - `node bin/arm.js off` 立即撤销；急停（tentacle_stop）不消耗武装。
 *
 * 默认路径为用户主目录（~/.tentacle-arm.json），而非包内路径：
 * 插件可能被安装多份（git clone、npm/profile 副本、临时验证目录），
 * 分布式安装下「用户在 A 副本 arm、DSH 加载 B 副本」必须读到同一文件，
 * 否则武装永远对不上、即插即用直接失效。TENTACLE_ARM_FILE 可显式覆盖。
 */

const DEFAULT_MINUTES = 30;
const MAX_MINUTES = 24 * 60;

function armFilePath() {
  if (process.env.TENTACLE_ARM_FILE) return process.env.TENTACLE_ARM_FILE;
  return path.join(os.homedir(), ".tentacle-arm.json");
}

/*
 * 写 arm 文件（由 bin/arm.js 调用，本地 CLI 场景）。
 */
function arm(minutes = DEFAULT_MINUTES) {
  const m = Math.max(1, Math.min(MAX_MINUTES, Math.round(Number(minutes) || DEFAULT_MINUTES)));
  const payload = {
    nonce: crypto.randomBytes(16).toString("hex"),
    armedAt: Date.now(),
    expiresAt: Date.now() + m * 60 * 1000,
    minutes: m,
  };
  fs.writeFileSync(armFilePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  return payload;
}

function disarm() {
  try {
    fs.unlinkSync(armFilePath());
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

/*
 * 读取当前武装状态（不产生副作用）。
 */
function readArm() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(armFilePath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { armed: false, reason: "未武装" };
    return { armed: false, reason: "arm 文件损坏：" + e.message };
  }
  if (!payload || typeof payload.expiresAt !== "number" || typeof payload.nonce !== "string") {
    return { armed: false, reason: "arm 文件格式错误" };
  }
  if (Date.now() > payload.expiresAt) {
    return { armed: false, reason: "武装已过期", expiredAt: payload.expiresAt };
  }
  return {
    armed: true,
    nonce: payload.nonce,
    minutes: payload.minutes,
    expiresAt: payload.expiresAt,
    remainingSeconds: Math.max(0, Math.round((payload.expiresAt - Date.now()) / 1000)),
  };
}

/*
 * 供 FeedbackRuntime 注入的 isArmed()。
 *
 * 语义：nonce 必须是「新出现」的——server 首次见到某 nonce 时
 * 视为生效并记住它；之后同一 nonce 持续有效直到过期或被替换。
 * 这样 stop 后立刻 start 不会被误判，而一份过期后重新生成的
 * arm（新 nonce）也会被正确接受。
 */
function createArmChecker() {
  let seenNonce = null;
  return function isArmed() {
    const state = readArm();
    if (!state.armed) {
      seenNonce = null;
      return false;
    }
    if (state.nonce !== seenNonce) seenNonce = state.nonce;
    return true;
  };
}

/*
 * 状态摘要（给 status 工具用）。不含 nonce，不暴露文件路径细节。
 */
function armSummary() {
  const state = readArm();
  if (!state.armed) return { armed: false, reason: state.reason };
  return {
    armed: true,
    minutes: state.minutes,
    remainingSeconds: state.remainingSeconds,
    expiresAt: state.expiresAt,
  };
}

module.exports = { arm, disarm, readArm, createArmChecker, armSummary, armFilePath, DEFAULT_MINUTES };
