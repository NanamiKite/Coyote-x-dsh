"use strict";
/*
 * 规则引擎：场景包招式 → 有界输出计划。
 *
 * 事件不能直接决定设备参数。
 *
 * 招式（move）
 *      ↓
 * 本地规则（上限 / 时长 / 通道 / 冷却）
 *      ↓
 * planMove() 钳制
 *      ↓
 * FeedbackRuntime 串行执行
 *
 * 所有 AI 可传入的数值都在这里被钳制；
 * CoyoteSafety 在设备层再钳制一次。
 */
const { waveforms } = require("../coyote/waveforms");

const defaults = Object.freeze({
  intensity: 20,
  maxIntensity: 40,
  durationMs: 1500,
  maxDurationMs: 5000,
  cooldown: 10,
  channel: "A",
});

function number(value, fallback, min, max) {
  if (value === "" || value == null || !Number.isFinite(Number(value))) return fallback;
  return Math.max(min, Math.min(max, Math.round(Number(value))));
}

function normalizeConfig(input = {}) {
  const c = { ...defaults, ...input };
  return {
    intensity: number(c.intensity, defaults.intensity, 0, 200),
    maxIntensity: number(c.maxIntensity, defaults.maxIntensity, 0, 200),
    durationMs: number(c.durationMs, defaults.durationMs, 100, 30000),
    maxDurationMs: number(c.maxDurationMs, defaults.maxDurationMs, 100, 30000),
    cooldown: number(c.cooldown, defaults.cooldown, 0, 3600),
    channel: ["A", "B", "AB"].includes(c.channel) ? c.channel : "A",
  };
}

/*
 * 招式定义（场景包内使用同一格式）：
 *
 * {
 *   id: "vine-wrap",
 *   name: "藤蔓缠绕",
 *   description: "缓慢收紧又松开的持续缠绕",
 *   kind: "sustain",           // sustain = 持续型，burst = 短促型，wave = 疏密随机
 *   intensity: 30,             // 期望强度，最终被本地 maxIntensity 钳制
 *   durationMs: 3000,          // 期望时长，最终被本地 maxDurationMs 钳制
 *   waveform: "slowPulse",     // 引用波形库；省略时按 kind 选默认
 *   intensityRange: [10, 30],  // 可选：疏密随机型的强度摆动区间
 * }
 */

const KIND_WAVEFORM = {
  sustain: "slowPulse",
  burst: "pulse",
  wave: "randomStep",
};

/*
 * 场景包里引用的波形名必须存在于波形库。
 */
function resolveFrames(move) {
  const name = move.waveform && Object.hasOwn(waveforms, move.waveform)
    ? move.waveform
    : KIND_WAVEFORM[move.kind] || "slowPulse";
  // 波形 Z 值自动钳制到 15 以下（Z>20 脉冲宽度超 100us，产生刺痛）
  return waveforms[name].data.map(([x, y, z]) => [x, y, Math.min(z, 15)]);
}

/*
 * 招式 → 输出计划。返回值直接交给 FeedbackRuntime.start()。
 *
 * AI 只能从场景包里选招式 id，不能传任意波形字节。
 * 传入的 intensity / durationMs 即使被篡改，也只会在
 * 本地规则上限内向下钳制，永远不会抬高上限。
 */
function planMove(move, input = {}) {
  if (!move || typeof move !== "object" || typeof move.id !== "string") {
    throw new Error("未知招式");
  }
  const cfg = normalizeConfig(input);
  const wantsChannel = ["A", "B", "AB"].includes(input.channel) ? input.channel : cfg.channel;

  const requestedIntensity = number(move.intensity, cfg.intensity, 0, 200);
  const base = Math.min(requestedIntensity, cfg.intensity, cfg.maxIntensity);

  /*
   * 疏密随机型（kind: "wave"）允许在
   * [intensityRange 下限, 上限] 摆动，
   * 但整体仍然受 cfg.maxIntensity 限制，
   * 且下限不低于 0、上限不高于 base 与 max 的较小值。
   */
  let intensity = base;
  let range = null;
  if (Array.isArray(move.intensityRange) && move.intensityRange.length === 2) {
    const lo = Math.max(0, Math.min(number(move.intensityRange[0], 0, 0, 200), base));
    const hi = Math.max(lo, Math.min(number(move.intensityRange[1], base, 0, 200), base, cfg.maxIntensity));
    intensity = hi;
    range = [lo, hi];
  }

  const requestedDuration = number(move.durationMs, cfg.durationMs, 100, 30000);
  const durationMs = Math.min(requestedDuration, cfg.durationMs, cfg.maxDurationMs);

  const frames = resolveFrames(move);
  if (!frames.length) throw new Error("招式没有有效波形");

  return {
    moveId: move.id,
    name: move.name || move.id,
    kind: move.kind || "sustain",
    channel: wantsChannel,
    waveformInterval: 100,
    intensity: Math.round(intensity),
    intensityRange: range,
    durationMs: Math.round(durationMs),
    waveformData: frames,
  };
}

module.exports = { defaults, normalizeConfig, planMove, KIND_WAVEFORM };
