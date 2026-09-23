# 郊狼xDSH（Coyote x DSH）

> 让每一段剧情都留下切身印象。

**郊狼（Coyote）× DeepSeek Harness** 的联名插件：AI 接入的**体感文字冒险** MCP 插件。
AI 主持场景包驱动的角色扮演剧情，用实时文字状态推进故事，
并通过**郊狼 Coyote V2/V3 外置反馈设备**执行**有界物理反馈**增强沉浸感。


## 免责声明

重要：本项目仅供技术研究、软件开发与个人实验使用。

本插件会通过 BLE 控制兼容设备输出电脉冲。用户应充分了解所连接设备及其输出特性，并自行确认设备适用于当前使用场景。

本项目作者及贡献者不对因使用本插件、修改源码、连接第三方设备、设备故障、协议实现差异、配置错误、武装状态下的执行、异常断连或其他不可预见情况所造成的任何直接或间接损失、设备损坏、人身伤害或其他后果承担责任。

插件内置的强度、时长、波形及协议范围限制属于软件层面的安全措施，不构成对设备实际输出或使用安全性的保证。不同硬件、固件版本及设备状态可能导致实际行为与软件预期存在差异；不得仅依据本插件中的限制判断设备是否安全。

使用前请确认：设备处于可控状态；已阅读制造商安全说明；已正确配置本地规则上限；能随时运行 `tentacle_stop` 或 `node bin/arm.js off` 立即停止。

如出现异常输出、无法停止或任何不确定情况，应立即停止使用并断开设备。使用本项目即表示你理解并接受上述风险。

## 安装（即插即用）

```sh
# git 仓库（推荐）
dsh plugin --profile web add github:<owner>/Coyote-x-dsh#main

# 本地目录
dsh plugin --profile web add D:/path/to/Coyote-x-dsh
```

一条命令完成：pnpm 装包（自动带依赖与 webbluetooth 预编译）→ 读取 package.json 的
`dsh.bundle.patch` → 叠入 [cordis.patch.yml](cordis.patch.yml) 配置层 → 插件以相对路径注册。
**装完重启 profile**（Web GUI：插件管理器 → 安装 → 立即启用 → 重启；CLI：`dsh up --profile web --restart`）。
加载后模型直接看到 `tentacle_status` 等 11 个工具（非 `mcp__` 前缀——进程内原生注册）。

安全上限在**插件内可配**，见下方「安全配置」；以后调参只需编辑 profile 的
`cordis.patch.yml` 覆盖 `id: tentacle` 行的 `config:`（配置热重载，改完即生效，
重载时先归零再换实例）。

## 安全配置

下表字段写在 [cordis.patch.yml](cordis.patch.yml)（或 profile 同 id 覆盖行）的 `config:` 里，
由 `src/plugin/index.mjs` 导出的 Config schema 校验：**越界值直接启动报错，不是静默钳制**。
这些是本机规则天花板；AI 只有工具调用权，接触不到该配置层。

| 字段 | 默认 | 硬上限 | 含义 |
| --- | --- | --- | --- |
| `backend` | `ble` | `ble` / `mock` | 真机 BLE 或无硬件调试 |
| `channel` | `A` | `A` / `B` / `AB` | 输出通道 |
| `intensity` | `20` | 0–200 | 默认强度挡位（协议 S = 挡位 × 7） |
| `maxIntensity` | `40` | **200** | 强度天花板：招式计划只能被钳到更低 |
| `durationMs` | `1500` | 100–30000 | 默认单次时长 ms |
| `maxDurationMs` | `5000` | **30000** | 时长天花板 ms |
| `cooldown` | `10` | 0–3600 | 两次反馈之间的冷却秒数 |

即使有人改 YAML 抬参，下面两层仍然独立钳制：`rules.planMove()`（0–200 挡位、
≤30000 ms、Z ≤15）与 `CoyoteSafety`（挡位 0–200、协议 S ≤2047、时长 ≤5000）。

## 安全模型（三层 + 门禁）

1. **本地武装（arm）门禁** —— 输出工具默认锁定。只有在设备所在电脑运行
   `node bin/arm.js on [--minutes N]`（默认 30 分钟）后 AI 才能执行反馈；
   `node bin/arm.js off` 立即撤销；到期自动失效。AI 无法自行武装。
2. **规则钳制** —— `rules.planMove()` 把招式计划钳制在本地强度/时长/通道上限内；
   场景包与 AI 都无法抬高上限。波形 Z 值自动 ≤15。
3. **设备层 Safety** —— `CoyoteSafety` 独立钳制 App 挡位 0–200、协议 S ≤ 2047、
   协议值 = 挡位 × 7 的防御检查，即使绕过上层也无法越界。

另外：

- `FeedbackRuntime` 串行写入队列 + 取消纪元：`tentacle_stop` 之后在途写入全部失效；
- 截止时间先于第一个异步 BLE 调用设定，**到时必归零**；
- 每次执行有**冷却**（可配置）；
- `tentacle_stop` 永远可用：不需武装、不受冷却限制；
- 断开 / 插件卸载 / 退出时自动归零并断开连接（含热重载换实例）。

## 武装工作流

```sh
cd Coyote-x-dsh
node bin/arm.js on --minutes 30   # 设备电脑上武装（AI 无法代替）
node bin/arm.js status            # 查看剩余时间
node bin/arm.js off               # 立即撤销
# profile 安装后也可在 profile 目录用：npx tentacle-arm on
```

武装文件默认在**用户主目录** `~/.tentacle-arm.json`：本机任意安装副本
（git clone、profile 内的包、`node_modules`）读写的都是同一文件，
「A 处武装、B 处加载」不会错位。可用 `TENTACLE_ARM_FILE` 显式改路径。
AI 请求执行反馈时若返回「未武装」，请自行运行上命令后再让它继续。

## 快速开始（开发）

```sh
npm install
npm test              # 15 项测试，mock 后端，无需硬件
```

需要 Node.js 20+。BLE 后端（`webbluetooth`）需要设备所在电脑支持蓝牙；
无论进程内还是 stdio 模式，输出都必须发生在连接设备的那台机器上。

### 非 DSH 宿主：stdio MCP 回退

其他 MCP 客户端（Codex / Claude Code 等）可直接用 stdio 入口：

```yaml
# 客户端的 MCP 配置
mcpServers:
  tentacle:
    command: node
    args: ['/path/to/Coyote-x-dsh/src/mcp/server.js']
    env:
      TENTACLE_BACKEND: ble        # 无硬件调试时改为 mock
      # 可选规则覆盖（stdio 模式专用，语义同上表）：
      # TENTACLE_MAX_INTENSITY: '40'
      # TENTACLE_MAX_DURATION_MS: '5000'
      # TENTACLE_COOLDOWN_S: '10'
      # TENTACLE_CHANNEL: 'A'      # A / B / AB
      # TENTACLE_RULES_JSON: '{"intensity":20,"maxIntensity":40}'
```

加载后模型会看到 `mcp__tentacle__tentacle_status` 等工具（该前缀由 mcp-client 生成；
进程内 bundle 模式无此前缀）。

## 工具

| 工具 | 行为 |
| --- | --- |
| `tentacle_status` | 读取连接、武装、冷却、运行中反馈、当前阶段与最近事件。只读 |
| `tentacle_scenario_list` | 列出全部场景包（内置 + 自定义）。只读 |
| `tentacle_scenario_start` | 载入场景包、重置账本、开始新局 |
| `tentacle_state_read` | 读取完整状态：阶段/字段/时间线/招式/人设。只读 |
| `tentacle_state_update` | 按 schema 更新字段（int 钳制，enum/bool 拒绝非法值）。不触发硬件 |
| `tentacle_state_advance` | 沿阶段图推进（防跨图乱跳）。不触发硬件 |
| `tentacle_feedback_list` | 招式列表 + 钳制后的实际输出计划。只读 |
| `tentacle_feedback_start` | 执行有界招式（需武装 + 已连接 + 冷却结束；须给剧情理由） |
| `tentacle_stop` | 立即停止并归零。**永远可用** |
| `tentacle_connect` / `tentacle_disconnect` | 连接 / 断开设备（连接后先归零） |

AI 不能：提高上限、传任意波形字节、跳过冷却、自行武装、在未开局时改状态、
夹带 schema 之外的参数（两宿主共用同一套参数白名单）。

## 内置场景包（原创）

| id | 标题 | 风格 | 一句话设定 |
| --- | --- | --- | --- |
| `spore-greenhouse` | 孢子温室 | 俏皮诡异 | 夜班温室里，共生藤蔓「珞珈」把你当成新宿主，好奇地试探。 |
| `abyss-dive` | 深渊潜航 | 幽闭悬疑 | 7000 米海沟，水母群「灯缕」把你的隔离服当成新的光缆。 |
| `clockwork-chase` | 发条城追缉 | 蒸汽朋克 | 偷走「秒针之心」后，你在三分钟内躲避全城发条执法者的追缉。 |
| `sympathetic-chain` | 共感之链 | 情感叙事 | 与封印魔女瑟琳结下共感契约，她的伤沿银链传到你身上。 |

每个场景包包含：世界观前言、NPC 人设口吻（`narrator`）、阶段图（`stages`）、
状态字段 schema（`state.fields`）、招式表（`moves`，各招绑定有界波形计划）、开场白与主持约定。

## 共创场景

在对话里和 AI 一起设计场景（世界观、NPC 口吻、阶段图、字段、招式），
把结果保存为 `src/game/scenarios/custom/<id>.json`（格式见 `custom/_template.json`），
MCP 重新连接（stdio）或插件重载（进程内）即加载。`_` 开头的文件不会被加载；
同 id 时自定义包覆盖内置包。

字段类型：`int`（带 min/max，写入自动钳制）、`bool`、`enum`（values 白名单）、`text`（≤300 字）。
招式 `kind`：`sustain` 持续 / `burst` 短促 / `wave` 疏密随机（可配 `intensityRange`）；
`stageGate` 可限制招式只在指定阶段可用。波形名从 `src/coyote/waveforms.js` 波形库选取。

**场景包无法突破安全上限**：所有招式计划仍经过 `planMove` 与 `CoyoteSafety` 双层钳制。

## 项目结构

```
Coyote-x-dsh/
├── package.json                        # dsh.bundle.patch 声明 bundle patch
├── cordis.patch.yml                    # DSH 配置层：插件注册 + 安全上限默认值
├── bin/arm.js                          # 本地武装 CLI（唯一解锁入口）
├── src/
│   ├── plugin/index.mjs                # DSH 进程内插件：Config schema + 11 工具注册
│   ├── mcp/server.js                   # stdio MCP 薄壳（非 DSH 宿主回退）
│   ├── game/
│   │   ├── session.js                  # 公共会话层：tools + dispatch（两宿主共用）
│   │   ├── scenarios/
│   │   │   ├── index.js                # 场景包加载与校验
│   │   │   ├── builtin/*.js            # 4 个原创内置场景包
│   │   │   └── custom/                 # 自定义场景包（*.json，_ 前缀跳过）
│   │   ├── GameState.js                # 文字状态账本（阶段图 + 字段 schema）
│   │   ├── FeedbackRuntime.js          # 串行写入 / 取消纪元 / 冷却 / 到时归零
│   │   ├── rules.js                    # 招式 → 有界计划（钳制层）
│   │   └── arm.js                      # 武装状态读写与检查器
│   └── coyote/
│       ├── CoyoteController.js         # BLE 控制器（复用参考项目）
│       ├── CoyoteProtocol.js / V3.js   # 协议编解码（复用参考项目）
│       ├── CoyoteSafety.js             # 设备层安全钳制（复用参考项目）
│       ├── waveforms.js                # 波形库（复用参考项目）
│       └── MockController.js           # 模拟后端（测试 / 无硬件）
└── tests/
    ├── core.test.js                    # 领域层 + stdio 端到端（11 项）
    └── plugin.test.js                  # 进程内插件（4 项，假 Cordis ctx）
```


## 许可证

MIT
