"use strict";
const { EventEmitter } = require("events");
const { defaultFieldValues } = require("./scenarios");

/*
 * 文字冒险状态账本。
 *
 * AI 通过工具读写这里的状态来推进剧情；
 * 所有写入都按场景包 schema 校验，越界值拒绝或钳制。
 *
 * 账本只改变游戏状态，永不直接触碰硬件——
 * 硬件输出只能走 FeedbackRuntime（Event → State → Runtime → BLE）。
 */
class GameState extends EventEmitter {
  constructor() {
    super();
    this.pack = null;
    this.data = null;
  }

  get active() {
    return !!this.pack;
  }

  /*
   * 载入场景包并重置账本。
   */
  load(pack) {
    if (!pack) throw new Error("未知场景包");
    this.pack = pack;
    const fields = defaultFieldValues(pack);
    this.data = {
      packId: pack.id,
      stage: pack.stages[0].id,
      turn: 0,
      fields,
      timeline: [],
      startedAt: Date.now(),
      ended: false,
    };
    this.record(`场景开始：${pack.title}`);
    this.emit("change");
    return this.status();
  }

  /*
   * 卸载（回到未开局状态）。
   */
  unload() {
    if (this.data) this.record("场景已卸载");
    this.pack = null;
    this.data = null;
    this.emit("change");
    return { active: false };
  }

  status() {
    if (!this.pack) return { active: false };
    const stage = this.pack.stages.find(s => s.id === this.data.stage) || this.pack.stages[0];
    const stageIndex = this.pack.stages.indexOf(stage);
    return {
      active: true,
      packId: this.pack.id,
      title: this.pack.title,
      premise: this.pack.premise,
      stage: stage.id,
      stageName: stage.name,
      stageHint: stage.hint,
      stageIndex,
      stageTotal: this.pack.stages.length,
      nextStage: stage.next || null,
      turn: this.data.turn,
      ended: this.data.ended,
      fields: { ...this.data.fields },
      fieldSpecs: this.pack.state.fields.map(f => ({
        key: f.key, label: f.label, type: f.type,
        min: f.min, max: f.max, values: f.values,
      })),
      recentEvents: this.data.timeline.slice(0, 12),
      moves: this.pack.moves.map(m => ({
        id: m.id, name: m.name, description: m.description,
        kind: m.kind, stageGate: m.stageGate || null,
      })),
      narrator: {
        persona: this.pack.narrator.persona,
        rules: this.pack.narrator.rules,
        guidelines: this.pack.guidelines,
      },
    };
  }

  record(text) {
    if (!this.data) return;
    this.data.timeline.unshift({ time: Date.now(), turn: this.data.turn, text: String(text).slice(0, 300) });
    this.data.timeline = this.data.timeline.slice(0, 60);
    this.emit("change");
  }

  /*
   * 推进阶段。target 省略时走当前阶段的 next。
   * 只允许跳到 next 指向的阶段或 "ended" 邻接标记（防 AI 乱跳）。
   */
  advance(target) {
    if (!this.data) throw new Error("尚未开始场景");
    if (this.data.ended) throw new Error("本局已结束，请 tentacle_scene_start 重开");
    const stage = this.pack.stages.find(s => s.id === this.data.stage);
    const next = target !== undefined && target !== null ? target : stage.next;
    if (!next || next === "ended") {
      this.data.ended = true;
      this.data.stage = "ended";
      this.record("场景结束：" + stage.name);
      this.emit("change");
      return this.status();
    }
    const dest = this.pack.stages.find(s => s.id === next);
    if (!dest) throw new Error(`未知阶段：${next}`);
    // 允许 next 或显式指定的相邻阶段（前一/后一），不允许跨图乱跳。
    const destIndex = this.pack.stages.indexOf(dest);
    const curIndex = this.pack.stages.indexOf(stage);
    const onPath = next === stage.next || Math.abs(destIndex - curIndex) <= 1;
    if (!onPath) throw new Error(`阶段 ${stage.id} 不能跳到 ${next}`);
    this.data.stage = dest.id;
    this.record(`阶段推进：${stage.name} → ${dest.name}`);
    this.emit("change");
    return this.status();
  }

  /*
   * 按 schema 更新字段。
   * patch: { key: value, ... }
   * - int: 越界钳制到 [min, max]（不拒绝，记录原值提示）
   * - enum/bool: 非法值拒绝
   * - text: 截断到 300 字符
   */
  update(patch) {
    if (!this.data) throw new Error("尚未开始场景");
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error("patch 必须是对象");
    }
    const specs = new Map(this.pack.state.fields.map(f => [f.key, f]));
    const clampNotes = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = specs.get(key);
      if (!spec) throw new Error(`未知状态字段：${key}（本场景允许：${[...specs.keys()].join(", ") || "无"}）`);
      if (this.data.ended && spec.type !== "text") {
        // 结束后只允许写 text 类型（例如结局备注）。
        throw new Error("本局已结束，状态只读");
      }
      if (spec.type === "int") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`字段 ${key} 需要数字`);
        const clamped = Math.max(spec.min, Math.min(spec.max, Math.round(n)));
        if (clamped !== Math.round(n)) clampNotes.push(`${key}: ${n} → ${clamped}`);
        this.data.fields[key] = clamped;
      } else if (spec.type === "bool") {
        if (typeof value !== "boolean") throw new Error(`字段 ${key} 需要布尔值`);
        this.data.fields[key] = value;
      } else if (spec.type === "enum") {
        if (!spec.values.includes(value)) {
          throw new Error(`字段 ${key} 必须是：${spec.values.join(" / ")}`);
        }
        this.data.fields[key] = value;
      } else {
        if (typeof value !== "string") throw new Error(`字段 ${key} 需要字符串`);
        this.data.fields[key] = value.slice(0, 300);
      }
    }
    this.data.turn += 1;
    if (clampNotes.length) this.record(`字段钳制：${clampNotes.join("，")}`);
    this.emit("change");
    return { ...this.status(), clamped: clampNotes };
  }

  /*
   * 招式是否允许在当前阶段使用。
   */
  canUseMove(move) {
    if (!this.data) return { ok: false, reason: "尚未开始场景" };
    if (this.data.ended) return { ok: false, reason: "本局已结束" };
    if (!Array.isArray(move.stageGate) || !move.stageGate.length) return { ok: true };
    if (move.stageGate.includes(this.data.stage)) return { ok: true };
    return { ok: false, reason: `招式「${move.name}」仅限阶段：${move.stageGate.join(" / ")}` };
  }
}

module.exports = { GameState };
