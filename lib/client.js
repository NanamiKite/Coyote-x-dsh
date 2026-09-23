/**
 * 郊狼xDSH 浏览器半侧（手写 loader-factory 产物）。
 *
 * 协议（dsh-client-modules / ui-plugin-manager README 均有记载）：
 *   window.__ModuleLoader__.load({ id: 裸包名, factory: (require) => module.exports })
 * id 必须等于 Loader 行的说明符（= 裸包名 coyote-x-dsh），loader 校验
 * 「bundle 加载后必须以该 id 注册」，对不上即激活失败。
 *
 * 本文件即源码：无构建步骤，改动直接进 git，Host 启动前快照它并在
 * /plugins 下提供。factory 收到的 require 由模块表注入——基座
 * PLATFORM_MODULES 提供 react / react/jsx-runtime，其他请求解析到
 * 已注册的包 row；本文件只 require react。
 *
 * 职责：往插件管理器的 `plugins.row.config`（key = <包名>#<行 id> =
 * coyote-x-dsh#tentacle）注册行配置页，用页面宿主传入的
 * ConfigPageForm { state: ConfigFormSnapshot, mutate(ops, revision) }
 * 渲染六个安全字段的表单。只有保存才写入；离开页面（组件卸载）时
 * 未保存的草稿天然丢弃，与官方配置页语义一致。
 */
window.__ModuleLoader__.load({
	id: "coyote-x-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const { useState } = React;

		/**
		 * 六个可调字段，与 src/plugin/index.mjs 的 Config schema、
		 * src/game/rules.js 的 normalizeConfig 边界逐项一致：
		 * 这里的 min/max 只是即时提示，硬校验永远发生在 Host 的 Config。
		 */
		const FIELDS = [
			{ key: "intensity", kind: "number", min: 0, max: 200, step: 1 },
			{ key: "maxIntensity", kind: "number", min: 0, max: 200, step: 1 },
			{ key: "durationMs", kind: "number", min: 100, max: 30000, step: 1 },
			{ key: "maxDurationMs", kind: "number", min: 100, max: 30000, step: 1 },
			{ key: "cooldown", kind: "number", min: 0, max: 3600, step: 1 },
			{ key: "channel", kind: "enum", options: ["A", "B", "AB"] },
		];
		const LABELS = {
			intensity: "默认强度（0–200 挡）",
			maxIntensity: "强度上限（0–200 挡，硬顶）",
			durationMs: "默认单次时长（ms，100–30000）",
			maxDurationMs: "时长上限（ms，硬顶 30000）",
			cooldown: "两次反馈之间的冷却（秒，0–3600）",
			channel: "输出通道",
		};
		const HINT = "这些值是本机硬顶：招式计划只能被钳得更低，对话里的任何操作都无法越过。保存即时生效（不重挂插件），正在运行中的有界计划按启动时的参数跑完。";
		const READ_ONLY = "当前配置不可写（部署为只读或命名空间未开放写入）。";
		const LOADING = "正在载入配置…";

		/** 当前展示值：草稿优先，否则取 Host 快照的 schema 解析值。 */
		function displayOf(field, value, draft) {
			if (draft && Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key];
			const raw = value[field.key];
			return raw === undefined || raw === null ? "" : String(raw);
		}

		/** 数字字段的即时校验：空或非数或越界即视为无效（Host 还会整体再校验一次）。 */
		function numberInvalid(field, text) {
			if (text.trim() === "") return true;
			const n = Number(text);
			return !Number.isFinite(n) || n < field.min || n > field.max;
		}

		/**
		 * 行配置页本体。
		 * @param props - 页面宿主传入的 slot owner 道具：{ view, form }。
		 */
		function TentacleConfig(props) {
			const [draft, setDraft] = useState(null);
			const [note, setNote] = useState("");
			const form = props.form;
			if (!form) return h("p", null, "配置表单尚未就绪：Host 未提供可写入的配置入口。");
			const snap = form.state;
			if (snap.status === "loading") return h("p", null, LOADING);
			const value = snap.value || {};
			const writable = snap.status === "ready" && snap.writable;
			const edit = (field, text) => {
				setDraft({ ...(draft || {}), [field.key]: text });
				setNote("");
			};
			const dirty = (field) => displayOf(field, value, draft) !== displayOf(field, value, null);
			const invalid = FIELDS.some((field) => field.kind === "number" && numberInvalid(field, displayOf(field, value, draft)));
			const hasDraft = draft !== null && FIELDS.some((field) => dirty(field));
			const save = async () => {
				const ops = FIELDS
					.filter((field) => dirty(field))
					.map((field) => ({
						op: "set",
						path: [field.key],
						value: field.kind === "number" ? Number(displayOf(field, value, draft)) : displayOf(field, value, draft),
					}));
				if (ops.length === 0) { setDraft(null); return; }
				let ok = false;
				try { ok = await form.mutate(ops, snap.revision); } catch (e) { ok = false; }
				if (ok) { setDraft(null); setNote(""); } else { setNote("部署没有接受这些值，已保留供你修改。"); }
			};
			const rows = FIELDS.map((field) => {
				const text = displayOf(field, value, draft);
				const bad = field.kind === "number" && numberInvalid(field, text);
				const control = field.kind === "enum"
					? h("select", {
						value: text,
						disabled: !writable,
						onChange: (e) => edit(field, e.target.value),
						style: FIELD_STYLE,
					}, field.options.map((opt) => h("option", { key: opt, value: opt }, opt)))
					: h("input", {
						type: "number",
						inputMode: "numeric",
						min: field.min,
						max: field.max,
						step: field.step,
						value: text,
						disabled: !writable,
						"aria-invalid": bad || undefined,
						onChange: (e) => edit(field, e.target.value),
						style: { ...FIELD_STYLE, ...(bad ? BAD_STYLE : null) },
					});
				return h("label", { key: field.key, style: ROW_STYLE },
					h("span", { style: LABEL_STYLE }, LABELS[field.key]),
					control,
					bad ? h("span", { style: ERROR_STYLE }, `请填 ${field.min}–${field.max} 之间的数字`) : null);
			});
			return h("div", { style: { display: "grid", gap: 8 } },
				h("p", { style: { margin: 0, opacity: 0.75 } }, HINT),
				!writable ? h("p", { style: { margin: 0, opacity: 0.75 } }, READ_ONLY) : null,
				h("div", { style: { display: "grid", gap: 6 } }, rows),
				note ? h("p", { style: { margin: 0, ...ERROR_STYLE } }, note) : null,
				writable ? h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
					h("button", { type: "button", disabled: invalid || !hasDraft, onClick: save, style: BUTTON_STYLE }, "保存"),
					hasDraft ? h("button", { type: "button", onClick: () => { setDraft(null); setNote(""); }, style: { ...BUTTON_STYLE, background: "transparent" } }, "放弃修改") : null,
				) : null);
		}

		const ROW_STYLE = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
		const LABEL_STYLE = { flex: "1 1 220px", minWidth: 0 };
		const FIELD_STYLE = {
			flex: "0 0 auto",
			minWidth: 96,
			padding: "4px 6px",
			color: "inherit",
			background: "transparent",
			border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
			borderRadius: 4,
			font: "inherit",
		};
		const BAD_STYLE = { borderColor: "#c0392b" };
		const ERROR_STYLE = { color: "#c0392b", fontSize: "0.85em" };
		const BUTTON_STYLE = {
			padding: "4px 14px",
			font: "inherit",
			borderRadius: 4,
			border: "1px solid color-mix(in srgb, currentColor 40%, transparent)",
			background: "color-mix(in srgb, currentColor 12%, transparent)",
			color: "inherit",
			cursor: "pointer",
		};

		/** 必需服务：插件管理器页面提供的 slot 注册表。 */
		exports.inject = ["slots"];

		/**
		 * 挂载行配置贡献：组合包开启期间注册，关闭即随之消失。
		 * @param ctx - 浏览器插件上下文（cordis，含 ctx.slots）。
		 */
		exports.apply = function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: "coyote-x-dsh#tentacle",
			}, (owner) => owner.view === "summary"
				? "郊狼xDSH：AI 体感反馈的安全参数（强度/时长/冷却/通道）在此调整。"
				: h(TentacleConfig, { form: owner.form }))), "coyote-x-dsh: row config");
		};

		return module.exports;
	},
});
