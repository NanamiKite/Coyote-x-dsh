/**
 * DSH 进程内 bundle 插件：把触手文字冒险的 11 个工具注册到 ctx.tools。
 *
 * Namespace plugin（具名导出，绝不 default export —— DSH 加载器按
 * `exports.default ?? exports` 解包，default 会吞掉同级的 name/inject/Config）。
 *
 * 即插即用路径：
 *   dsh plugin --profile web add <本包路径或 git 地址>
 *      → pnpm 装包 → 识别 package.json 的 dsh.bundle.patch
 *      → 叠入 cordis.patch.yml 层 → 本模块按相对路径加载
 *   安全上限（强度/时长/冷却/通道/后端）写在同层 config: 块里，
 *   由 Config schema 校验（越界 = 拒绝写入/启动），AI 工具层无法触碰。
 *
 * 可视化调参（DSH 设置页）：
 *   intensity / maxIntensity / durationMs / maxDurationMs / cooldown / channel
 *   六个字段标注 `.volatile()` —— 设置表单直接展示，保存即完整 Config
 *   校验即持久化，且 **不重挂插件**：loader 把新值提交进运行中的引用后
 *   发出 `loader/volatile-update`，本插件据此就地同步 runtime.config，
 *   下一次反馈立即使用新参数（运行中的有界计划按启动参数跑完即止）。
 *   backend 不做 volatile：换后端 = 换控制器，走普通更新（自动重挂）。
 *
 * 生命周期：effect 卸载 → 归零输出、断开设备、注销工具；
 * 配置热重载（dsh-hmr）即「先卸旧实例再载新实例」，同样先归零。
 *
 * @module coyote-x-dsh/plugin
 */

// 本包为 CommonJS，此入口特意用 .mjs：CJS 内容一律经 default 互操作取回，
// 不依赖 cjs-module-lexer 对具名导出的静态分析。
import sessionModule from '../game/session.js'
import rulesModule from '../game/rules.js'
import z from '@deepseek-ai/schemastery'

const { createSession, TOOL_DEFINITIONS, INSTRUCTIONS } = sessionModule
const { normalizeConfig } = rulesModule

/** Cordis 插件名（加载器诊断用）。 */
export const name = 'tentacle-text-adventure'

/** 依赖服务：工具注册表。systemPrompt 可选，缺省时仅跳过提示词段。 */
export const inject = ['tools']

/**
 * 安全配置 schema。
 *
 * 每个字段的 min/max 都是**硬上限**：
 *   - 与 src/game/rules.js 的 normalizeConfig 边界一致（双层钳制：
 *     这里越界直接拒绝写入/启动，那里再钳一次）；
 *   - 设备层还有 CoyoteSafety（挡位 0–200、协议 0–2047）独立兜底。
 *
 * 因此即使有人改 YAML 抬参数，也永远到不了协议上限之上；
 * 而 AI 只有工具调用权，根本接触不到本 schema。
 *
 * 可调六字段带 `.volatile()`：DSH 设置页可编辑、修改不重挂、
 * 运行时用 `.get()` 现取（教程约定：保持引用，单次操作内取值、
 * 不跨操作缓存）。backend 保持普通字段。
 */
export const Config = z.object({
  /** 输出后端：真机 BLE 或测试用 mock（普通字段，改后自动重挂）。 */
  backend: z.union([z.const('ble'), z.const('mock')]).default('ble'),
  /** 输出通道：A / B / 双通道同发（设置页可改，即时生效）。 */
  channel: z.union([z.const('A'), z.const('B'), z.const('AB')]).default('A').volatile(),
  /** 默认强度挡位（0–200，协议 S = 挡位 × 7）。 */
  intensity: z.number().step(1).min(0).max(200).default(20).volatile(),
  /** 强度上限：招式计划只能被钳到更低，任何层都无法越过的本机天花板。 */
  maxIntensity: z.number().step(1).min(0).max(200).default(40).volatile(),
  /** 默认单次时长 ms（≥100）。 */
  durationMs: z.number().step(1).min(100).max(30000).default(1500).volatile(),
  /** 时长上限 ms（硬顶 30000；FeedbackRuntime 独立再钳一次）。 */
  maxDurationMs: z.number().step(1).min(100).max(30000).default(5000).volatile(),
  /** 两次反馈之间的冷却秒数（0–3600）。 */
  cooldown: z.number().step(1).min(0).max(3600).default(10).volatile(),
})

/** 原始 JSON-Schema 工具 → ToolRuntime 定义（照 mcp-client 的桥接形状）。 */
function toDefinition(tool, session) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    // 任意 JSON 值均可：统一按 JSON 文本投影给模型。
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    /*
     * 错误直接抛出：ToolRuntime 会为模型生成 isError 结果
     * （与 mcp-client 对 MCP isError 的处理一致）。
     */
    execute: (args) => session.dispatch(tool.name, args),
  }
}

/**
 * 挂载会话并注册全部工具。
 * 同步普通函数（与 dsh-tool-goal 同形）：返回值非 Promise，
 * 不会被 Cordis 当成构造器语义处理。
 * @param ctx - Cordis 上下文（含 tools 注册表、loader 事件）。
 * @param config - 经 Config schema 校验并补全默认值的本地配置；
 *                 volatile 字段为引用，须用 `.get()` 现取。
 */
export function apply(ctx, config) {
  /*
   * 每次现取 volatile 引用的值（教程：保持引用，单次操作内取值，
   * 不跨操作缓存）。初次构建 rules 与之后的 volatile-update 同步共用。
   */
  const readRules = () => ({
    intensity: config.intensity.get(),
    maxIntensity: config.maxIntensity.get(),
    durationMs: config.durationMs.get(),
    maxDurationMs: config.maxDurationMs.get(),
    cooldown: config.cooldown.get(),
    channel: config.channel.get(),
  })

  const session = createSession({
    backend: config.backend,
    rules: readRules(),
    logger: (...message) => ctx.logger.info('[tentacle]', ...message),
  })

  /*
   * 设置页保存（或 profile patch 热重载）产生纯 volatile 变更时，
   * loader 已把新值提交进上面的引用；这里把规则对象就地刷新：
   * 下一次 feedback_start / 冷却检查 / status 即读到新天花板。
   * 正在运行的有界计划保持启动时的参数跑完即止，不被中途改写。
   */
  ctx.on('loader/volatile-update', () => {
    try {
      Object.assign(session.runtime.config, normalizeConfig(readRules()))
    } catch (e) {
      ctx.logger.error('[tentacle] volatile 同步失败：', e.message)
    }
  })

  // 注册随插件 fiber 生效，卸载时由 Cordis 自动注销。
  for (const tool of session.tools) {
    ctx.tools.register(toDefinition(tool, session))
  }

  /*
   * 会话级玩法守则注入系统提示词。
   * systemPrompt 是可选服务（SDK 极简组合可能没有）：缺省时仅少一段
   * 引导文本，工具描述本身已携带操作规则。
   */
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    systemPrompt.section({
      name: 'tool:tentacle',
      // 稳定排位：落在工具段之后、SDK 段之前。
      order: 3200,
      text: session.instructions,
    })
  }

  // 卸载/热重载时先归零再释放，绝不留着运行中的输出。
  ctx.effect(() => () => void session.shutdown(), 'tentacle-text-adventure.session')
}
