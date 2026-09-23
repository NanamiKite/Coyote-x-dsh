"use strict";
const { EventEmitter } = require("events");
const { normalizeConfig, planMove } = require("./rules");

/*
 * 反馈运行时。
 *
 * 借鉴参考项目 SceneRuntime 的三个硬性质：
 *   1. 所有入口共享一个串行写入队列（写入不交错）；
 *   2. 取消纪元 epoch —— stop() 之后在途写入全部失效；
 *   3. 截止时间先于第一个异步 BLE 调用设定，到时必归零。
 *
 * 与参考项目的差异（按用户选择的执行模型）：
 *   - 没有「提案 + 侧边栏批准」—— armed 时 AI 直接有界执行；
 *   - arm 是本地 CLI 状态，每次 start 前重新检查；
 *   - stop 永远可用（不看 arm、不看冷却）。
 */
class FeedbackRuntime extends EventEmitter {
  constructor(controller, config) {
    super();
    this.controller = controller;
    this.config = normalizeConfig(config);
    this.epoch = 0;
    this.queue = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.deadline = null;
    this.events = [];
    this.cooldownUntil = 0;
    this.lastProposal = null;
    this.disposed = false;
    /*
     * armed 由本地注入（arm 模块）。
     * 默认函数返回 false：未武装时输出工具一律拒绝。
     */
    this.isArmed = () => false;
  }

  record(text) {
    this.events.unshift({ time: Date.now(), text });
    this.events = this.events.slice(0, 40);
    this.emit("change");
  }

  write(epoch, operation) {
    const job = this.queue.then(() => {
      if (epoch === this.epoch) return operation();
    });
    this.queue = job.catch(() => {});
    return job;
  }

  cooldownRemainingMs() {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  setConfig(input) {
    this.config = normalizeConfig(input);
    // 修改规则会撤销正在进行的计划参照（保留输出本身，由调用方决定是否 stop）。
    this.emit("change");
  }

  /*
   * 启动一个有界反馈计划。
   *
   * source 参数只用于事件日志展示（例如招式名 + AI 给的剧情理由）。
   */
  async start(plan, source = "反馈") {
    if (this.disposed) throw new Error("运行时已关闭");
    if (!this.isArmed()) {
      throw new Error("未武装：请在设备所在电脑运行 `node bin/arm.js on` 后重试（AI 无法自行武装）");
    }
    if (!this.controller.connected) throw new Error("请先连接设备（tentacle_connect）");
    if (this.running) throw new Error("已有反馈运行中，请先 tentacle_stop");
    const remain = this.cooldownRemainingMs();
    if (remain > 0) throw new Error(`冷却中，请 ${Math.ceil(remain / 1000)} 秒后再试`);

    const cfg = this.config;
    // 再钳制一次：即使 planMove 被绕过，这里也只允许向下。
    const bounded = planMove({
      id: plan.moveId || "ad-hoc",
      name: plan.name,
      kind: plan.kind,
      intensity: plan.intensity,
      intensityRange: plan.intensityRange,
      durationMs: plan.durationMs,
      waveform: plan.waveform,
    }, { ...cfg, channel: plan.channel });

    const interval = bounded.waveformInterval;
    if (!Number.isInteger(interval) || interval < 20 || interval > 5000) {
      throw new Error("波形间隔必须是 20–5000ms");
    }
    if (!["A", "B", "AB"].includes(bounded.channel)) throw new Error("无效通道");
    const durationMs = Math.max(0, Math.min(bounded.durationMs, cfg.maxDurationMs, 30000));
    if (!durationMs || (!bounded.intensity && bounded.kind !== "sustain")) {
      throw new Error("当前输出强度或时长为 0");
    }

    const a = bounded.channel.includes("A") ? Math.max(0, Math.min(bounded.intensity, cfg.maxIntensity, 200)) : 0;
    const b = bounded.channel.includes("B") ? Math.max(0, Math.min(bounded.intensity, cfg.maxIntensity, 200)) : 0;

    const frames = bounded.waveformData.map(frame => {
      if (!Array.isArray(frame) || frame.length !== 3 ||
          frame.some(v => !Number.isInteger(v)) ||
          frame[0] < 0 || frame[0] > 31 || frame[1] < 0 || frame[1] > 1023 || frame[2] < 0 || frame[2] > 15) {
        throw new Error("场景波形超出支持范围");
      }
      return [...frame];
    });
    if (!frames.length) throw new Error("场景没有有效波形");

    const epoch = ++this.epoch;
    this.controller._clearAllTimers();
    const started = Date.now();
    this.cooldownUntil = started + cfg.cooldown * 1000;
    this.running = {
      ...bounded,
      intensity: Math.max(a, b),
      intensityA: a,
      intensityB: b,
      durationMs,
      source,
      startedAt: started,
      endsAt: started + durationMs,
    };
    this.record(`${source}：${bounded.name} / A=${a} / B=${b} / ${durationMs}ms`);

    // 截止时间先于第一个异步 BLE 调用。
    this.deadline = setTimeout(() => {
      this.stop("反馈到时归零").catch(e => this.record("归零失败：" + e.message));
    }, durationMs);

    try {
      await this.write(epoch, () => this.controller.setIntensity(a, b));
      if (epoch !== this.epoch) return;
      let index = 0;
      const v3 = this.controller.version === 3;
      const sendInterval = v3 ? 100 : interval;
      const tick = async () => {
        if (epoch !== this.epoch || !this.running) return;
        if (!this.controller.connected || Date.now() >= started + durationMs) {
          await this.stop("反馈完成");
          return;
        }
        index = Math.max(index, Math.floor((Date.now() - started) / sendInterval));
        const windowStart = index++ * sendInterval;
        try {
          if (v3) {
            const window = [0, 25, 50, 75].map(offset => frames[Math.floor((windowStart + offset) / interval) % frames.length]);
            await this.write(epoch, () => this.controller.setWaveformWindow(
              this.running?.channel.includes("A") ? window : null,
              this.running?.channel.includes("B") ? window : null));
          } else {
            const f = frames[Math.floor(windowStart / interval) % frames.length];
            await this.write(epoch, () => this.running?.channel.includes("A") && this.controller.setWaveformA(...f));
            await this.write(epoch, () => this.running?.channel.includes("B") && this.controller.setWaveformB(...f));
          }
          if (epoch === this.epoch) {
            if (v3) index = Math.max(index, Math.floor((Date.now() - started) / sendInterval) + 1);
            this.timer = setTimeout(() => tick().catch(e => this.record(e.message)),
              Math.max(0, started + index * sendInterval - Date.now()));
          }
        } catch (e) {
          await this.stop("波形发送失败：" + e.message).catch(error => this.record("归零失败：" + error.message));
          throw e;
        }
      };
      await tick();
    } catch (e) {
      await this.stop("启动失败").catch(() => {});
      throw e;
    }
  }

  /*
   * 永远可用：不检查 arm、不检查冷却。
   * 取消纪元、清定时器、入队归零。
   */
  async stop(reason = "已停止") {
    ++this.epoch;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    this.timer = null;
    this.deadline = null;
    this.running = null;
    this.controller._clearAllTimers();
    const zero = this.queue.then(() => this.controller.emergencyStop());
    this.queue = zero.catch(() => {});
    this.record(reason);
    await zero;
    this.emit("change");
  }

  async dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.stop("运行时关闭").finally(() => this.removeAllListeners());
    return this.disposePromise;
  }
}

module.exports = { FeedbackRuntime };
