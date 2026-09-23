"use strict";
/*
 * 场景包加载器。
 *
 * 一个场景包 = 世界观前言 + NPC 人设口吻 + 阶段图
 *             + 状态字段 schema + 招式表 + 主持约定。
 *
 * 内置包来自 ./builtin/，自定义包来自 ./custom/*.json
 * （在对话里与用户共创的场景保存到 custom/ 即可生效，
 *   重启 MCP 连接加载）。
 *
 * 招式最终输出仍经过 rules.planMove() 与 CoyoteSafety 双层钳制，
 * 场景包无法抬高本地安全上限。
 */
const fs = require("fs");
const path = require("path");

const BUILTIN_DIR = path.join(__dirname, "builtin");
const CUSTOM_DIR = path.join(__dirname, "custom");

const KINDS = ["sustain", "burst", "wave"];
const FIELD_TYPES = ["int", "bool", "enum", "text"];

function fail(packId, message) {
  throw new Error(`场景包 ${packId} 无效：${message}`);
}

function validatePack(pack, source) {
  if (!pack || typeof pack !== "object") fail(source, "必须是对象");
  const id = pack.id;
  if (typeof id !== "string" || !/^[a-z0-9-]{2,32}$/.test(id)) {
    fail(source, "id 必须是 2–32 位小写字母/数字/连字符");
  }
  if (typeof pack.title !== "string" || !pack.title.trim() || pack.title.length > 60) {
    fail(id, "title 必须是 1–60 字符");
  }
  if (typeof pack.premise !== "string" || !pack.premise.trim() || pack.premise.length > 2000) {
    fail(id, "premise 必须是 1–2000 字符的世界观前言");
  }
  if (!pack.narrator || typeof pack.narrator.persona !== "string" || !pack.narrator.persona.trim()) {
    fail(id, "narrator.persona（NPC 人设口吻）缺失");
  }
  if (!Array.isArray(pack.narrator.rules)) pack.narrator.rules = [];
  pack.narrator.rules = pack.narrator.rules.filter(r => typeof r === "string").slice(0, 20);

  // 阶段图：至少一个阶段，id 唯一，next 只能引用存在的阶段或结束标记。
  if (!Array.isArray(pack.stages) || !pack.stages.length) fail(id, "stages 至少要有 1 个阶段");
  const stageIds = new Set();
  for (const stage of pack.stages) {
    if (!stage || typeof stage.id !== "string" || !stage.id) fail(id, "存在缺少 id 的阶段");
    if (stageIds.has(stage.id)) fail(id, `阶段 id 重复：${stage.id}`);
    stageIds.add(stage.id);
    if (typeof stage.name !== "string" || !stage.name) fail(id, `阶段 ${stage.id} 缺少 name`);
    if (typeof stage.hint !== "string") stage.hint = "";
  }
  pack.stages.push({ id: "ended", name: "本局结束", hint: "场景已收尾，状态只读。" });
  for (const stage of pack.stages) {
    const next = stage.next;
    if (next !== undefined && next !== null && next !== "ended" && !stageIds.has(next)) {
      fail(id, `阶段 ${stage.id} 的 next=${next} 不存在`);
    }
  }

  // 状态字段 schema。
  if (!pack.state || !Array.isArray(pack.state.fields)) pack.state = { fields: [] };
  const fieldKeys = new Set();
  for (const field of pack.state.fields) {
    if (!field || typeof field.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(field.key)) {
      fail(id, "状态字段 key 必须是字母开头的 1–32 位标识符");
    }
    if (fieldKeys.has(field.key)) fail(id, `状态字段 key 重复：${field.key}`);
    fieldKeys.add(field.key);
    if (!FIELD_TYPES.includes(field.type)) fail(id, `字段 ${field.key} 类型必须是 ${FIELD_TYPES.join("/")}`);
    if (field.type === "enum") {
      if (!Array.isArray(field.values) || !field.values.length || field.values.some(v => typeof v !== "string")) {
        fail(id, `枚举字段 ${field.key} 需要非空字符串 values`);
      }
    }
    if (field.type === "int") {
      field.min = Number.isFinite(field.min) ? field.min : 0;
      field.max = Number.isFinite(field.max) ? field.max : 100;
      if (field.min > field.max) fail(id, `字段 ${field.key} min > max`);
    }
    if (typeof field.label !== "string") field.label = field.key;
  }

  // 招式表：id 唯一，kind 合法，数值字段交给 planMove 再钳制。
  if (!Array.isArray(pack.moves) || !pack.moves.length) fail(id, "moves 至少要有 1 个招式");
  const moveIds = new Set();
  for (const move of pack.moves) {
    if (!move || typeof move.id !== "string" || !/^[a-z0-9-]{2,32}$/.test(move.id)) {
      fail(id, "招式 id 必须是 2–32 位小写字母/数字/连字符");
    }
    if (moveIds.has(move.id)) fail(id, `招式 id 重复：${move.id}`);
    moveIds.add(move.id);
    if (typeof move.name !== "string" || !move.name) fail(id, `招式 ${move.id} 缺少 name`);
    if (typeof move.description !== "string") move.description = "";
    if (!KINDS.includes(move.kind)) fail(id, `招式 ${move.id} 的 kind 必须是 ${KINDS.join("/")}`);
    // stageGate 可选：限制招式只能在指定阶段使用。
    if (move.stageGate !== undefined && move.stageGate !== null) {
      if (!Array.isArray(move.stageGate) || move.stageGate.some(s => !stageIds.has(s))) {
        fail(id, `招式 ${move.id} 的 stageGate 引用了不存在的阶段`);
      }
    }
  }

  if (!Array.isArray(pack.guidelines)) pack.guidelines = [];
  pack.guidelines = pack.guidelines.filter(g => typeof g === "string").slice(0, 30);
  if (!Array.isArray(pack.openings)) pack.openings = [];
  pack.openings = pack.openings.filter(o => typeof o === "string").slice(0, 10);

  pack.__source = source;
  return pack;
}

function loadJsPack(file) {
  const source = path.basename(file);
  delete require.cache[require.resolve(file)];
  return validatePack(require(file), source);
}

function loadJsonPack(file) {
  const source = path.basename(file);
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { fail(source, `JSON 解析失败：${e.message}`); }
  return validatePack(parsed, source);
}

function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      // 以 _ 开头的文件是模板/说明，不是场景包。
      .filter(f => !f.startsWith("_"))
      .sort()
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/*
 * 加载全部场景包。custom 覆盖同名 builtin（允许用户改出厂包）。
 * 单个包校验失败不会拖垮整个 server，错误收集在 errors 里，
 * 由 status 工具暴露给用户排查。
 */
function loadPacks() {
  const packs = new Map();
  const errors = [];
  for (const file of listFiles(BUILTIN_DIR, ".js")) {
    try {
      const pack = loadJsPack(file);
      packs.set(pack.id, pack);
    } catch (e) { errors.push(e.message); }
  }
  for (const file of listFiles(CUSTOM_DIR, ".json")) {
    try {
      const pack = loadJsonPack(file);
      packs.set(pack.id, pack);
    } catch (e) { errors.push(e.message); }
  }
  return { packs: [...packs.values()], errors };
}

function defaultFieldValues(pack) {
  const values = {};
  for (const field of pack.state.fields) {
    if (field.default !== undefined) { values[field.key] = field.default; continue; }
    if (field.type === "int") values[field.key] = field.min;
    else if (field.type === "bool") values[field.key] = false;
    else if (field.type === "enum") values[field.key] = field.values[0];
    else values[field.key] = "";
  }
  return values;
}

module.exports = { loadPacks, defaultFieldValues, CUSTOM_DIR };
