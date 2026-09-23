"use strict";
/*
 * 进程内 bundle 插件测试。
 *
 * 用假 Cordis ctx（tools.register / effect / get / on / logger）
 * 驱动真实的 apply()，覆盖：
 *   - namespace 插件导出契约（禁止 default export）
 *   - Config schema 默认值与硬上限（越界拒绝，volatile 包装后仍拒绝）
 *   - volatile 字段经引用 `.get()` 读取
 *   - 11 个工具注册 + 参数白名单
 *   - arm 门禁 / Config 钳制 / stop 永远可用
 *   - effect 卸载必须归零
 *   - systemPrompt 段为可选注册
 *   - volatile 设置链路：loader/volatile-update 接线 +
 *     runtime.config 就地更新后下一次操作立即按新值钳制
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

// 独立 arm 文件，隔离真实状态与 core.test.js。
process.env.TENTACLE_ARM_FILE = path.join(os.tmpdir(), `tentacle-plugin-arm-${process.pid}.json`);

const arm = require("../src/game/arm");
const pluginPromise = import("../src/plugin/index.mjs");

/*
 * 执行 Config schema：优先按 schemastery 的可调用约定
 * （非法输入抛错）；兼容 Standard Schema 实现。
 */
async function parseConfig(Config, data) {
  if (typeof Config === "function") return Config(data);
  const std = Config && Config["~standard"];
  if (std && typeof std.validate === "function") {
    const r = await std.validate(data);
    if (r.issues) throw new Error(r.issues.map(i => i.message).join("; "));
    return r.value;
  }
  throw new Error("Config schema 不可执行");
}

async function rejectsConfig(Config, data) {
  try {
    await parseConfig(Config, data);
    return false;
  } catch {
    return true;
  }
}

/*
 * 最小假 ctx：登记注册表、effect 卸载器、事件监听、可选 systemPrompt 段。
 */
function makeCtx(withPrompt = false) {
  const defs = new Map();
  const effects = [];
  const sections = [];
  const listeners = [];
  return {
    defs,
    effects,
    sections,
    listeners,
    tools: {
      register(def) {
        defs.set(def.name, def);
        return () => defs.delete(def.name);
      },
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    on(event, fn) {
      const entry = { event, fn };
      listeners.push(entry);
      return () => {
        const i = listeners.indexOf(entry);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    get(key) {
      if (key === "systemPrompt" && withPrompt) {
        return { section(s) { sections.push(s); return () => {}; } };
      }
      return undefined;
    },
    logger: { info() {}, error() {} },
  };
}

const BASE_CONFIG = {
  backend: "mock",
  channel: "A",
  intensity: 15,
  maxIntensity: 30,
  durationMs: 800,
  maxDurationMs: 2000,
  cooldown: 0,
};

test("命名导出契约：name / inject / Config / apply，且无 default", async () => {
  const ns = await pluginPromise;
  assert.ok(!("default" in ns), "namespace 插件禁止 default export（DSH 加载器会解包吞掉同级导出）");
  assert.equal(ns.name, "tentacle-text-adventure");
  assert.deepEqual(ns.inject, ["tools"]);
  assert.ok(ns.Config, "Config schema 必须存在");
  assert.equal(typeof ns.apply, "function");
});

test("Config 默认值生效（volatile 经 .get() 读取），越界输入被硬拒绝", async () => {
  const { Config } = await pluginPromise;

  const defaults = await parseConfig(Config, {});
  // backend 是普通字段，直接是值。
  assert.equal(defaults.backend, "ble");
  // 可调六字段是 volatile 引用，须 .get() 读取。
  assert.equal(defaults.channel.get(), "A");
  assert.equal(defaults.intensity.get(), 20);
  assert.equal(defaults.maxIntensity.get(), 40);
  assert.equal(defaults.durationMs.get(), 1500);
  assert.equal(defaults.maxDurationMs.get(), 5000);
  assert.equal(defaults.cooldown.get(), 10);

  // 硬上限：volatile 包装不得削弱校验，任何抬高天花板的配置都进不了启动。
  const badCases = [
    { maxIntensity: 500 },          // 超 200 挡位天花板
    { intensity: -1 },              // 负强度
    { durationMs: 60000 },          // 超 30s 硬顶
    { maxDurationMs: 99999 },       // 上限字段越界
    { cooldown: -5 },               // 负冷却
    { cooldown: 99999 },            // 冷却越界
    { backend: "usb" },             // 非法后端
    { channel: "C" },               // 非法通道
    { maxIntensity: "high" },       // 类型错误
    { intensity: 3.5 },             // 非整数挡位
  ];
  for (const data of badCases) {
    assert.equal(
      await rejectsConfig(Config, data),
      true,
      `应当拒绝：${JSON.stringify(data)}`,
    );
  }

  // 合法的部分覆盖不报错。
  const partial = await parseConfig(Config, { maxIntensity: 60, cooldown: 30 });
  assert.equal(partial.maxIntensity.get(), 60);
  assert.equal(partial.cooldown.get(), 30);
  assert.equal(partial.intensity.get(), 20);
});

test("apply 注册 11 个工具；arm 门禁、Config 钳制、stop 永远可用；卸载归零", async (t) => {
  t.after(() => arm.disarm());
  arm.disarm();

  const { Config, apply } = await pluginPromise;
  const config = await parseConfig(Config, BASE_CONFIG);
  const ctx = makeCtx();
  apply(ctx, config);

  assert.equal(ctx.defs.size, 11, "应注册全部 11 个工具");
  for (const def of ctx.defs.values()) {
    assert.equal(typeof def.execute, "function");
    assert.ok(def.description.length > 10, `${def.name} 需要描述`);
    assert.equal(typeof def.parameters, "object");
  }

  const call = (name, args) => {
    const def = ctx.defs.get(name);
    assert.ok(def, `工具未注册：${name}`);
    return def.execute(args || {});
  };

  // 参数白名单（schema 之外的键拒绝，AI 无法夹带强度参数）。
  await assert.rejects(call("tentacle_status", { intensity: 200 }), /不支持的参数/);

  // 开局引导：未连接 + 未武装（rules 已自定义）→ guidance 列出两项待办。
  const pre = await call("tentacle_status");
  assert.ok(Array.isArray(pre.guidance), "status 应返回 guidance 数组");
  assert.ok(pre.guidance.some(g => g.includes("arm.js")), "未武装时应引导 arm 命令");
  assert.ok(pre.guidance.some(g => g.includes("未连接")), "未连接时应引导打开设备");
  assert.ok(!pre.guidance.some(g => g.includes("出厂默认")), "已自定义规则不应提示出厂默认");

  // 开局 + 连接（mock 后端）。
  const started = await call("tentacle_scenario_start", { packId: "spore-greenhouse" });
  assert.equal(started.started, true);
  const conn = await call("tentacle_connect");
  assert.equal(conn.connected, true);

  // 未武装 → 拒绝执行。
  const moves = await call("tentacle_feedback_list");
  assert.ok(moves.length >= 4, "场景应含招式表");
  const mv = moves.find(m => m.available);
  assert.ok(mv, "至少一个招式当前可用");
  await assert.rejects(
    call("tentacle_feedback_start", { moveId: mv.id, reason: "测试" }),
    /未武装/,
  );

  // 本地武装 → 放行，且输出钳制在 Config 上限内。
  arm.arm(1);
  const exec = await call("tentacle_feedback_start", { moveId: mv.id, reason: "测试" });
  assert.equal(exec.started, true);
  assert.ok(exec.plan.intensity <= 30, "强度必须被 maxIntensity 钳制");
  assert.ok(exec.plan.durationMs <= 800, "时长必须被 durationMs 钳制");

  // stop 永远可用。
  assert.equal((await call("tentacle_stop")).status, "stopped");

  // 再次执行，验证 effect 卸载路径归零。
  await call("tentacle_feedback_start", { moveId: mv.id, reason: "卸载前" });
  const before = await call("tentacle_status");
  assert.deepEqual(before.guidance, [], "已武装已连接且规则自定义时无引导待办");
  assert.ok(before.running, "卸载前应有反馈在运行");

  assert.equal(ctx.effects.length, 1, "应登记一个 effect 卸载器");
  assert.equal(ctx.effects[0].label, "tentacle-text-adventure.session");
  await ctx.effects[0].dispose();

  const after = await call("tentacle_status");
  assert.equal(after.running, null, "卸载后必须归零");
  assert.equal(after.backend, "mock");
  assert.equal(after.rules.maxIntensity, 30, "status 应反映 Config 规则");
});

test("volatile 设置链路：loader 监听接线 + 规则就地更新即时生效", async (t) => {
  t.after(() => arm.disarm());
  arm.disarm();

  const { Config, apply } = await pluginPromise;
  const config = await parseConfig(Config, BASE_CONFIG);
  const ctx = makeCtx();
  apply(ctx, config);

  // 1) 监听 loader/volatile-update（设置页保存 → loader 提交 → 本事件）。
  const entry = ctx.listeners.find(l => l.event === "loader/volatile-update");
  assert.ok(entry, "应监听 loader/volatile-update");
  assert.equal(typeof entry.fn, "function");
  assert.doesNotThrow(() => entry.fn([]), "volatile 同步 handler 不得抛错");

  const call = (name, args) => {
    const def = ctx.defs.get(name);
    assert.ok(def, `工具未注册：${name}`);
    return def.execute(args || {});
  };
  await call("tentacle_scenario_start", { packId: "spore-greenhouse" });

  // 2) status 返回的 rules 是运行时配置的活引用。
  const status = await call("tentacle_status");
  assert.equal(status.rules.maxIntensity, 30);

  // 3) 模拟 volatile 提交完成后的同步结果（就地改 runtime.config）：
  //    下一次操作立即按新天花板钳制 —— 证明规则对象每次操作现读、非启动快照。
  status.rules.maxIntensity = 5;
  status.rules.durationMs = 100;
  const moves = await call("tentacle_feedback_list");
  const mv = moves.find(m => m.available);
  assert.ok(mv, "至少一个招式当前可用");
  assert.ok(mv.plan.intensity <= 5, "计划强度应即时反映新 maxIntensity");
  assert.ok(mv.plan.durationMs <= 100, "计划时长应即时反映新 durationMs");

  await ctx.effects[0].dispose();
});

test("guidance：出厂默认配置时提示初始设置可调", async () => {
  const { Config, apply } = await pluginPromise;
  const config = await parseConfig(Config, {});
  const ctx = makeCtx();
  apply(ctx, config);

  const status = await ctx.defs.get("tentacle_status").execute({});
  assert.ok(Array.isArray(status.guidance));
  assert.ok(status.guidance.some(g => g.includes("出厂默认")), "默认配置应提示可在设置页完成初始设置");
  assert.ok(status.guidance.some(g => g.includes("arm.js")), "未武装应给 arm 命令");

  await ctx.effects[0].dispose();
});

test("systemPrompt 段可选：有服务则注册玩法守则", async () => {
  const { Config, apply } = await pluginPromise;
  const config = await parseConfig(Config, BASE_CONFIG);
  const ctx = makeCtx(true);
  apply(ctx, config);

  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, "tool:tentacle");
  assert.equal(ctx.sections[0].order, 3200);
  assert.ok(ctx.sections[0].text.length > 50, "玩法守则文本应完整注入");

  await ctx.effects[0].dispose();
});
