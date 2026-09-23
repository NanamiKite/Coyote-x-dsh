"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");

const { loadPacks } = require("../src/game/scenarios");
const { planMove, normalizeConfig } = require("../src/game/rules");
const { FeedbackRuntime } = require("../src/game/FeedbackRuntime");
const { GameState } = require("../src/game/GameState");
const { MockController } = require("../src/coyote/MockController");
const arm = require("../src/game/arm");

// 独立 arm 文件，避免污染真实状态。
process.env.TENTACLE_ARM_FILE = path.join(os.tmpdir(), `tentacle-test-arm-${process.pid}.json`);

function controller() {
  const c = new MockController();
  c.connected = true;
  c.connection = { state: "connected", message: "test", error: "", startedAt: 0 };
  return c;
}

test("四个内置场景包全部通过校验", () => {
  const { packs, errors } = loadPacks();
  assert.deepEqual(errors, []);
  const ids = packs.map(p => p.id).sort();
  assert.deepEqual(ids, ["abyss-dive", "clockwork-chase", "spore-greenhouse", "sympathetic-chain"]);
  for (const pack of packs) {
    assert.ok(pack.premise.length > 50, pack.id + " 需要完整前言");
    assert.ok(pack.narrator.persona.length > 20, pack.id + " 需要 NPC 人设");
    assert.ok(pack.moves.length >= 4, pack.id + " 至少 4 个招式");
    assert.ok(pack.stages.some(s => s.id === "ended"), "加载器应补 ended 哨兵");
  }
});

test("planMove 钳制强度/时长，场景包无法抬高上限", () => {
  const cfg = normalizeConfig({ intensity: 20, maxIntensity: 30, durationMs: 1000, maxDurationMs: 2000 });
  const greedy = { id: "x", name: "X", kind: "burst", intensity: 200, durationMs: 30000 };
  const plan = planMove(greedy, cfg);
  assert.equal(plan.intensity, 20);
  assert.equal(plan.durationMs, 1000);
  // 波形 Z 全部 ≤15
  for (const [, , z] of plan.waveformData) assert.ok(z <= 15);
  assert.throws(() => planMove(null, cfg), /未知招式/);
});

test("intensityRange 摆动但不越上限", () => {
  const cfg = normalizeConfig({ intensity: 40, maxIntensity: 25, durationMs: 4000, maxDurationMs: 5000 });
  const plan = planMove(
    { id: "w", name: "W", kind: "wave", intensity: 40, intensityRange: [10, 40], durationMs: 4000 },
    cfg);
  assert.equal(plan.intensity, 25);
  assert.deepEqual(plan.intensityRange, [10, 25]);
});

test("未武装时 start 被拒绝，arm 后放行；stop 永远可用", async t => {
  const c = controller();
  const r = new FeedbackRuntime(c, { cooldown: 0 });
  t.after(() => r.dispose());
  r.isArmed = arm.createArmChecker();

  const plan = planMove({ id: "m", name: "M", kind: "burst", intensity: 10, durationMs: 300 }, r.config);
  await assert.rejects(r.start(plan, "t"), /未武装/);
  assert.equal(c.writes.length, 0);

  arm.arm(1);
  t.after(() => arm.disarm());
  await r.start(plan, "armed");
  assert.ok(c.writes.some(w => w[0] === "S" && w[1] > 0));
  await r.stop("test stop"); // 不需要再检查 arm
  assert.equal(r.running, null);
  assert.deepEqual(c.writes.at(-1), ["STOP"]);
});

test("过期武装自动失效", async () => {
  arm.arm(1);
  const payload = JSON.parse(fs.readFileSync(arm.armFilePath(), "utf8"));
  payload.expiresAt = Date.now() - 1;
  fs.writeFileSync(arm.armFilePath(), JSON.stringify(payload));
  const checker = arm.createArmChecker();
  assert.equal(checker(), false);
  arm.disarm();
});

test("串行执行、冷却与到时归零", async t => {
  const c = controller();
  const r = new FeedbackRuntime(c, { cooldown: 5, durationMs: 400, maxDurationMs: 500, intensity: 15, maxIntensity: 40 });
  t.after(() => r.dispose());
  r.isArmed = () => true;

  const plan = planMove({ id: "m", name: "M", kind: "burst", intensity: 15, durationMs: 400 }, r.config);
  await r.start(plan, "first");
  assert.ok(r.cooldownRemainingMs() > 0);
  // 运行中再次 start：运行中锁先命中，同样拒绝
  await assert.rejects(r.start(plan, "again"), /冷却|运行中/);
  // 手动停止后仍在冷却窗口 → 只因冷却被拒
  await r.stop("测试停止");
  await assert.rejects(r.start(plan, "after-stop"), /冷却/);

  await delay(500);
  assert.equal(r.running, null, "停止后保持归零");
  assert.deepEqual(c.writes.at(-1), ["STOP"]);
});

test("stop 使在途写入失效（epoch）", async () => {
  const c = controller();
  let release;
  c.setIntensity = async (a, b) => {
    await new Promise(res => { release = res; });
    c.writes.push(["S", a, b]);
  };
  const r = new FeedbackRuntime(c, { cooldown: 0 });
  r.isArmed = () => true;
  const plan = planMove({ id: "m", name: "M", kind: "burst", intensity: 10, durationMs: 500 }, r.config);
  const starting = r.start(plan, "in-flight");
  await delay(5);
  const stopping = r.stop("打断");
  release();
  await Promise.all([starting, stopping]);
  await delay(50);
  assert.equal(r.running, null);
  assert.deepEqual(c.writes.at(-1), ["STOP"]);
  await r.dispose();
});

test("BLE 写入失败时归零", async () => {
  const c = controller();
  c.failNextWrite = new Error("adapter failure");
  const r = new FeedbackRuntime(c, { cooldown: 0 });
  r.isArmed = () => true;
  const plan = planMove({ id: "m", name: "M", kind: "burst", intensity: 10, durationMs: 500 }, r.config);
  await assert.rejects(r.start(plan, "fail"), /adapter failure/);
  assert.equal(r.running, null);
  assert.deepEqual(c.writes.at(-1), ["STOP"]);
  await r.dispose();
});

test("GameState：阶段图推进受相邻约束、字段按 schema 钳制/拒绝", () => {
  const { packs } = loadPacks();
  const game = new GameState();
  const pack = packs.find(p => p.id === "spore-greenhouse");
  game.load(pack);
  assert.equal(game.data.stage, "awakening");

  // 字段钳制：marks 超上限 → 钳到 3
  const r1 = game.update({ marks: 99 });
  assert.equal(game.data.fields.marks, 3);
  assert.ok(r1.clamped.length === 1);
  // 枚举非法值 → 拒绝
  assert.throws(() => game.update({ mood: "暴怒" }), /必须是/);
  // 未知字段 → 拒绝
  assert.throws(() => game.update({ hp: 10 }), /未知状态字段/);
  // 阶段推进
  game.advance();
  assert.equal(game.data.stage, "cat-and-mouse");
  // 跳到不存在的阶段 → 拒绝
  assert.throws(() => game.advance("nope"), /未知阶段/);
  // 推进到 mark-trial 后，回跳 awakening（非 next 且不相邻）→ 拒绝
  game.advance(); // cat-and-mouse → mark-trial
  assert.equal(game.data.stage, "mark-trial");
  assert.throws(() => game.advance("awakening"), /不能跳到/);
});

test("招式 stageGate 在错误阶段被拒绝", () => {
  const { packs } = loadPacks();
  const game = new GameState();
  game.load(packs.find(p => p.id === "clockwork-chase"));
  const gated = { id: "g", name: "G", stageGate: ["cornered"] };
  assert.equal(game.canUseMove(gated).ok, false);
  game.data.stage = "cornered";
  assert.equal(game.canUseMove(gated).ok, true);
});

test("MCP stdio 端到端：发现工具、状态、开局、未武装拒绝、武装后执行、停止", async t => {
  process.env.TENTACLE_BACKEND = "mock";
  process.env.TENTACLE_COOLDOWN_S = "0";
  arm.disarm();

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  const client = new Client({ name: "tentacle-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, "..", "src", "mcp", "server.js")],
    env: { ...process.env, TENTACLE_BACKEND: "mock", TENTACLE_COOLDOWN_S: "0", TENTACLE_ARM_FILE: process.env.TENTACLE_ARM_FILE },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  t.after(async () => {
    await client.close();
    arm.disarm();
  });
  await client.connect(transport);

  const list = await client.callTool({ name: "tentacle_scenario_list", arguments: {} });
  const packs = JSON.parse(list.content[0].text);
  assert.equal(packs.length, 4);

  let result = await client.callTool({ name: "tentacle_status", arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.armed.armed, false);
  assert.equal(status.backend, "mock");

  // 未开局就更新状态 → 错误
  result = await client.callTool({ name: "tentacle_state_read", arguments: {} });
  assert.equal(result.isError, true);

  // 开局
  result = await client.callTool({ name: "tentacle_scenario_start", arguments: { packId: "sympathetic-chain" } });
  assert.notEqual(result.isError, true);
  const started = JSON.parse(result.content[0].text);
  assert.equal(started.packId, "sympathetic-chain");

  // 连接设备（mock 后端）
  result = await client.callTool({ name: "tentacle_connect", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).connected, true);
  // 幂等
  result = await client.callTool({ name: "tentacle_connect", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).already, true);

  // 招式列表带钳制计划
  result = await client.callTool({ name: "tentacle_feedback_list", arguments: {} });
  const moves = JSON.parse(result.content[0].text);
  assert.ok(moves.length >= 4);
  for (const m of moves) assert.ok(m.plan.intensity <= 40, "默认 maxIntensity=40");

  // 未武装 → 拒绝执行
  result = await client.callTool({
    name: "tentacle_feedback_start",
    arguments: { moveId: "chain-tighten", reason: "她紧张了" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未武装/);

  // 本地武装后执行成功
  arm.arm(1);
  result = await client.callTool({
    name: "tentacle_feedback_start",
    arguments: { moveId: "chain-tighten", reason: "她紧张了" },
  });
  assert.notEqual(result.isError, true);
  const exec = JSON.parse(result.content[0].text);
  assert.equal(exec.started, true);

  // 多余参数被拒绝
  result = await client.callTool({
    name: "tentacle_feedback_start",
    arguments: { moveId: "chain-tighten", reason: "x", intensity: 200 },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /不支持的参数/);

  // 停止永远可用
  result = await client.callTool({ name: "tentacle_stop", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).status, "stopped");

  // 状态字段更新走 schema
  result = await client.callTool({ name: "tentacle_state_update", arguments: { patch: { bond: 999, selene_mood: "动摇" } } });
  assert.notEqual(result.isError, true);
  const upd = JSON.parse(result.content[0].text);
  assert.equal(upd.fields.bond, 10);
});
