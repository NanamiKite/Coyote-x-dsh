"use strict";
/*
 * 公共会话层：场景包 + 状态账本 + 反馈运行时 + 武装门禁。
 *
 * 两个宿主复用同一实现：
 *   - src/mcp/server.js    → stdio MCP（Codex / Claude Code 等）
 *   - src/plugin/index.mjs → DSH 进程内 bundle 插件（即插即用）
 *
 * 安全边界与工具语义在两宿主间完全一致：
 *   planMove 钳制 + arm 检查 + 冷却 + stop 永远可用。
 */
const { loadPacks } = require("./scenarios");
const { GameState } = require("./GameState");
const { FeedbackRuntime } = require("./FeedbackRuntime");
const { planMove, normalizeConfig } = require("./rules");
const { createArmChecker, armSummary, disarm } = require("./arm");

const empty = { type: "object", properties: {}, additionalProperties: false };

/*
 * 工具定义（JSON-Schema 形状，两宿主通用）。
 * stdio 侧直接用于 MCP list；进程内侧经 ctx.tools.register() 消费。
 */
const TOOL_DEFINITIONS = [
  {
    name: "tentacle_status",
    description: "读取连接、武装、冷却、运行中反馈、当前场景阶段与最近事件。只读，不触发硬件。",
    inputSchema: empty,
  },
  {
    name: "tentacle_scenario_list",
    description: "列出全部场景包（内置 + 自定义）的 id、标题与世界观摘要，供开局选择。只读。",
    inputSchema: empty,
  },
  {
    name: "tentacle_scenario_start",
    description: "载入指定场景包并重置状态账本，开始新的文字冒险。会结束当前已开局状态。",
    inputSchema: {
      type: "object",
      properties: { packId: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["packId"],
      additionalProperties: false,
    },
  },
  {
    name: "tentacle_state_read",
    description: "读取当前场景完整状态：阶段、字段、时间线、可用招式、NPC 人设。每轮叙述前先调用。只读。",
    inputSchema: empty,
  },
  {
    name: "tentacle_state_update",
    description: "按场景包 schema 更新状态字段（int 按 schema 钳制，enum/bool 非法值拒绝）。只改游戏状态，不触发硬件。",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "object" } },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "tentacle_state_advance",
    description: "沿阶段图推进剧情（省略 target 则走当前阶段的 next）。不允许跨图乱跳。只改游戏状态，不触发硬件。",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", maxLength: 64 } },
      additionalProperties: false,
    },
  },
  {
    name: "tentacle_feedback_list",
    description: "列出当前场景的招式及按本地规则钳制后的实际输出计划（强度/时长/通道/冷却）。只读，不触发硬件。",
    inputSchema: empty,
  },
  {
    name: "tentacle_feedback_start",
    description: "执行一个有界反馈招式（需本地武装 + 设备已连接 + 冷却结束）。输出受本地强度/时长上限钳制，到时自动归零。reason 为剧情理由，会记入事件日志。",
    inputSchema: {
      type: "object",
      properties: {
        moveId: { type: "string", minLength: 1, maxLength: 64 },
        reason: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["moveId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "tentacle_stop",
    description: "立即停止运行中的反馈并归零。永远可用：不需武装、不受冷却限制。用户要求停止时第一时间调用。",
    inputSchema: empty,
  },
  {
    name: "tentacle_connect",
    description: "连接反馈设备（扫描并连接郊狼 V2/V3，或模拟后端直连）。连接后会先归零输出。幂等。",
    inputSchema: empty,
  },
  {
    name: "tentacle_disconnect",
    description: "停止输出并断开设备连接。幂等。",
    inputSchema: empty,
  },
];

/*
 * 会话级提示词（DSH 进程内插件注册为 systemPrompt section；
 * stdio 侧作为 Server instructions 下发）。
 */
const INSTRUCTIONS = [
  "你主持一场纯文字冒险（场景包驱动），并通过有界反馈工具增强沉浸感。",
  "规则：",
  "1. 开局先 tentacle_status，再 tentacle_scenario_list 选包，tentacle_scenario_start 开局。",
  "2. 每轮先 tentacle_state_read 读真实状态再叙述；状态推进用 tentacle_state_update / tentacle_state_advance 持久化，不要凭空 invent 进度。",
  "3. 需要物理反馈时 tentacle_feedback_list 看招式，再 tentacle_feedback_start 执行；招式输出受本地强度/时长/冷却上限钳制。",
  "4. 反馈工具需要用户本地武装（arm）。若返回未武装，告知用户运行 `node bin/arm.js on`，不要反复重试，更不要假装输出已发生。",
  "5. 返回成功只代表有界计划已启动；不要推断或宣称电气/生理/医疗效果，只在剧情层面描写。",
  "6. 用户要求停止时立即 tentacle_stop（该工具永远可用，不需武装）。",
  "7. 你扮演场景包 narrator.persona 描述的角色；遵守 narrator.rules 与 guidelines。",
  "8. 这是文字冒险：不读取图片/摄像头，所有画面由文字构建。",
].join("\n");

/*
 * 本地规则配置：env 覆盖默认值（stdio 场景常用），
 * options.rules 为显式传入值（DSH 插件 Config 场景），显式值优先。
 */
function resolveRules(options = {}) {
  let envBase = {};
  if (process.env.TENTACLE_RULES_JSON) {
    try { envBase = JSON.parse(process.env.TENTACLE_RULES_JSON); }
    catch { /* 解析失败按未设置处理，会话层不因此崩溃 */ }
  }
  const num = (v) => v !== undefined ? Number(v) : undefined;
  const envPart = {
    intensity: num(process.env.TENTACLE_INTENSITY),
    maxIntensity: num(process.env.TENTACLE_MAX_INTENSITY),
    durationMs: num(process.env.TENTACLE_DURATION_MS),
    maxDurationMs: num(process.env.TENTACLE_MAX_DURATION_MS),
    cooldown: num(process.env.TENTACLE_COOLDOWN_S),
    channel: process.env.TENTACLE_CHANNEL,
  };
  const merged = { ...envBase, ...envPart, ...(options.rules || {}) };
  // 剔除 undefined，避免覆盖 env/default。
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  return normalizeConfig(merged);
}

/*
 * 建立一个会话。每个宿主一个实例（stdio：每进程一个；
 * 插件：每个插件实例一个，effect 卸载时 shutdown）。
 *
 * options.backend: 'mock' | 'ble'（缺省取 TENTACLE_BACKEND 或 'ble'）
 * options.rules:   显式规则覆盖（DSH Config），优先于 env
 * options.logger:  可选 (...args) => void，默认 stderr
 */
function createSession(options = {}) {
  const { packs, errors: packErrors } = loadPacks();
  const packMap = new Map(packs.map(p => [p.id, p]));

  const log = options.logger || ((...args) => console.error("[tentacle]", ...args));

  const backend = options.backend
    || process.env.TENTACLE_BACKEND
    || "ble";
  const useMock = backend === "mock";

  const rules = resolveRules(options);

  const controller = useMock
    ? new (require("../coyote/MockController").MockController)()
    : new (require("../coyote/CoyoteController").CoyoteController)();

  const runtime = new FeedbackRuntime(controller, rules);
  runtime.isArmed = createArmChecker();
  const game = new GameState();

  controller.on("connectionChanged", c => log("connection:", c.state, c.message));

  function statusPayload() {
    const running = runtime.running ? {
      name: runtime.running.name,
      moveId: runtime.running.moveId,
      channel: runtime.running.channel,
      intensity: runtime.running.intensity,
      intensityA: runtime.running.intensityA,
      intensityB: runtime.running.intensityB,
      durationMs: runtime.running.durationMs,
      source: runtime.running.source,
      endsInMs: Math.max(0, runtime.running.endsAt - Date.now()),
    } : null;
    return {
      backend,
      connected: !!controller.connected,
      connection: {
        state: controller.connection?.state || "idle",
        message: controller.connection?.message || "",
        error: controller.connection?.error || "",
      },
      version: controller.version ?? null,
      battery: controller.battery ?? null,
      channelA: controller.channelA ?? 0,
      channelB: controller.channelB ?? 0,
      armed: armSummary(),
      cooldownRemainingMs: runtime.cooldownRemainingMs(),
      running,
      rules: runtime.config,
      scenario: game.active ? {
        packId: game.data.packId,
        stage: game.data.stage,
        stageName: game.status().stageName,
        turn: game.data.turn,
        ended: game.data.ended,
      } : null,
      packErrors,
      recentEvents: runtime.events.slice(0, 8),
    };
  }

  function requirePack(id) {
    const pack = packMap.get(id);
    if (!pack) {
      throw new Error(`未知场景包：${id}（可用：${[...packMap.keys()].join(", ") || "无"}）`);
    }
    return pack;
  }

  function requireGame() {
    if (!game.active) throw new Error("尚未开始场景，请先 tentacle_scenario_start");
    return game;
  }

  function findMove(id) {
    const g = requireGame();
    const move = g.pack.moves.find(m => m.id === id);
    if (!move) {
      throw new Error(`未知招式：${id}（本场景可用：${g.pack.moves.map(m => m.id).join(", ")}）`);
    }
    return move;
  }

  async function dispatch(name, args) {
    /*
     * 参数白名单：inputSchema 之外的键一律拒绝。
     * stdio 宿主与进程内宿主共用此检查，行为一致。
     */
    const def = TOOL_DEFINITIONS.find(t => t.name === name);
    if (!def) throw new Error("Unknown tool");
    const allowed = Object.keys(def.inputSchema.properties || {});
    const extra = Object.keys(args && typeof args === "object" ? args : {})
      .filter(k => !allowed.includes(k));
    if (extra.length) throw new Error(`不支持的参数：${extra.join(", ")}`);
    args = args && typeof args === "object" ? args : {};

    switch (name) {
      case "tentacle_status":
        return statusPayload();

      case "tentacle_scenario_list":
        return packs.map(p => ({
          id: p.id,
          title: p.title,
          premise: p.premise.slice(0, 400),
          stages: p.stages.filter(s => s.id !== "ended").map(s => ({ id: s.id, name: s.name })),
          moves: p.moves.length,
          source: p.__source,
        }));

      case "tentacle_scenario_start": {
        const pack = requirePack(args.packId);
        // 开局前若有输出在跑，先停下（换场景 = 换氛围）。
        if (runtime.running) await runtime.stop("切换场景");
        const status = game.load(pack);
        runtime.record(`场景载入：${pack.title}`);
        return {
          started: true,
          packId: pack.id,
          title: pack.title,
          opening: pack.openings[0] || pack.premise.slice(0, 120),
          stage: status.stage,
        };
      }

      case "tentacle_state_read":
        return requireGame().status();

      case "tentacle_state_update": {
        const g = requireGame();
        const result = g.update(args.patch);
        return { ok: true, stage: result.stage, turn: result.turn, fields: result.fields, clamped: result.clamped };
      }

      case "tentacle_state_advance": {
        const g = requireGame();
        const s = g.advance(args.target);
        return { ok: true, stage: s.stage, stageName: s.stageName, ended: s.ended };
      }

      case "tentacle_feedback_list": {
        const g = requireGame();
        return g.pack.moves.map(move => {
          const gate = g.canUseMove(move);
          const plan = planMove(move, runtime.config);
          return {
            id: move.id,
            name: move.name,
            description: move.description,
            kind: move.kind,
            available: gate.ok,
            unavailableReason: gate.reason || null,
            plan: {
              channel: plan.channel,
              intensity: plan.intensity,
              intensityRange: plan.intensityRange,
              durationMs: plan.durationMs,
            },
          };
        });
      }

      case "tentacle_feedback_start": {
        const g = requireGame();
        const move = findMove(args.moveId);
        const gate = g.canUseMove(move);
        if (!gate.ok) throw new Error(gate.reason);
        const reason = String(args.reason || "").trim();
        if (!reason) throw new Error("reason 不能为空：每次反馈都要有剧情理由");
        const plan = planMove(move, runtime.config);
        await runtime.start(plan, `${move.name} · ${reason}`);
        g.record(`反馈：${move.name}（${reason}）`);
        return {
          started: true,
          moveId: move.id,
          name: move.name,
          plan: {
            channel: runtime.running?.channel ?? plan.channel,
            intensity: runtime.running?.intensity ?? plan.intensity,
            durationMs: runtime.running?.durationMs ?? plan.durationMs,
            cooldownMs: runtime.config.cooldown * 1000,
          },
          note: "有界计划已启动；到时自动归零。此为软件发送计划，非电气或体感测量。",
        };
      }

      case "tentacle_stop": {
        await runtime.stop("AI 请求停止");
        if (game.active) game.record("反馈被停止");
        return { status: "stopped" };
      }

      case "tentacle_connect": {
        if (controller.connected) return { connected: true, already: true };
        if (typeof controller.scanDevices === "function" && !useMock) {
          const devices = await controller.scanDevices();
          await controller.connect(devices[0]?.id);
        } else {
          await controller.connect();
        }
        return {
          connected: controller.connected,
          version: controller.version,
          battery: controller.battery,
          message: controller.connection?.message || "",
        };
      }

      case "tentacle_disconnect": {
        await runtime.stop("断开设备");
        await controller.disconnect();
        return { connected: false };
      }

      default:
        throw new Error("Unknown tool");
    }
  }

  /*
   * 会话清理：归零、断开、释放监听器。
   * 幂等，宿主卸载/退出时调用。
   */
  let disposed = false;
  async function shutdown() {
    if (disposed) return;
    disposed = true;
    try { await runtime.dispose(); } catch (e) { log("runtime dispose:", e.message); }
    try { controller.dispose(); } catch (e) { log("controller dispose:", e.message); }
  }

  return {
    backend,
    packs,
    packErrors,
    tools: TOOL_DEFINITIONS,
    instructions: INSTRUCTIONS,
    dispatch,
    shutdown,
    // 便于测试注入
    runtime,
    game,
    controller,
    packMap,
    requirePack,
    requireGame,
    findMove,
    statusPayload,
  };
}

module.exports = { createSession, TOOL_DEFINITIONS, INSTRUCTIONS };
