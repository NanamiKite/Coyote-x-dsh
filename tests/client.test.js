/**
 * 浏览器半侧（lib/client.js）测试：零构建的产物即源码——直接经
 * window.__ModuleLoader__.load 协议加载它，用注入的 fake require、
 * fake React 与 fake ctx 走完「注册 → slot 挂载 → 配置页渲染」链路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/** 最小 React 替身：element 树可遍历，hooks 返回初值即可。 */
function makeReact() {
  return {
    createElement: (type, props, ...children) => {
      const merged = { ...(props || {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
  };
}

/** 深度收集 element 树中命中的节点。 */
function collect(node, predicate, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out);
    return out;
  }
  if ('type' in node && 'props' in node) {
    if (predicate(node)) out.push(node);
    collect(node.props.children, predicate, out);
  }
  return out;
}

/** 按 loader 协议加载 bundle，取回注册项。 */
function loadRegistration() {
  let captured = null;
  global.window = {
    __ModuleLoader__: {
      load: (registration) => { captured = registration; },
    },
  };
  delete require.cache[require.resolve('../lib/client.js')];
  require('../lib/client.js');
  delete global.window;
  assert.ok(captured, 'bundle 必须经 window.__ModuleLoader__.load 注册');
  return captured;
}

/** 加载 → 执行 factory → apply 到 fake ctx → 取回 row 配置页的 render。 */
function mount() {
  const registration = loadRegistration();
  const React = makeReact();
  const exportsObj = registration.factory((id) => {
    if (id === 'react') return React;
    throw new Error('未预期的 require: ' + id);
  });
  let render = null;
  const injected = [];
  const ctx = {
    effect: (thunk) => thunk(),
    slots: {
      inject: (name, produce) => { injected.push(name); return produce(); },
      register: (options, component) => { render = { options, component }; return () => {}; },
    },
  };
  exportsObj.apply(ctx);
  return { registration, exportsObj, injected, render };
}

/** 构造页面宿主传入的 ConfigPageForm。 */
function makeForm(value, overrides = {}, mutations = []) {
  return {
    state: {
      status: 'ready',
      value,
      base: undefined,
      user: undefined,
      revision: 3,
      writable: true,
      mode: 'host',
      ...overrides,
    },
    mutate: async (ops, revision) => { mutations.push({ ops, revision }); return true; },
  };
}

const SAFE_VALUE = {
  intensity: 20,
  maxIntensity: 40,
  durationMs: 1500,
  maxDurationMs: 5000,
  cooldown: 10,
  channel: 'A',
};

test('bundle 以裸包名注册 factory', () => {
  const registration = loadRegistration();
  assert.equal(registration.id, 'coyote-x-dsh');
  assert.equal(typeof registration.factory, 'function');
});

test('factory 导出 inject/apply；apply 挂上 plugins.row.config 且 key 正确', () => {
  const { exportsObj, injected, render } = mount();
  assert.deepEqual(exportsObj.inject, ['slots']);
  assert.equal(typeof exportsObj.apply, 'function');
  assert.equal(injected[0], 'plugins.row.config');
  assert.equal(render.options.name, 'plugins.row.config');
  assert.equal(render.options.key, 'coyote-x-dsh#tentacle');
});

test('summary 视图返回一句话描述', () => {
  const { render } = mount();
  const text = render.component({ view: 'summary', form: undefined });
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('郊狼'), 'summary 应说明这是郊狼的配置页');
});

test('page 视图渲染六字段表单：初值来自 Host 快照，无草稿时保存禁用', () => {
  const { render } = mount();
  const form = makeForm(SAFE_VALUE);
  const element = render.component({ view: 'page', form });
  assert.equal(typeof element.type, 'function', 'page 应渲染配置组件');
  assert.equal(element.props.form, form);

  const tree = element.type(element.props);
  const labels = collect(tree, (n) => n.type === 'label');
  assert.equal(labels.length, 6, '应有六个字段行');
  const inputs = collect(tree, (n) => n.type === 'input');
  assert.equal(inputs.length, 5, '五个数字字段');
  const selects = collect(tree, (n) => n.type === 'select');
  assert.equal(selects.length, 1, '通道为下拉框');
  assert.equal(selects[0].props.value, 'A');
  assert.ok(inputs.some((n) => n.props.value === '1500'), '时长初值应展示 Host 值');
  assert.ok(inputs.some((n) => n.props.value === '40'), '强度上限初值应展示 Host 值');

  const save = collect(tree, (n) => n.type === 'button').find((n) => n.props.children === '保存');
  assert.ok(save, '保存按钮存在');
  assert.equal(save.props.disabled, true, '无改动时保存禁用');
});

test('loading 状态只显示载入文案', () => {
  const { render } = mount();
  const form = makeForm(undefined, { status: 'loading' });
  const element = render.component({ view: 'page', form });
  const tree = element.type(element.props);
  assert.equal(tree.type, 'p');
  assert.ok(String(tree.props.children).includes('载入'));
});

test('不可写状态禁用输入并隐藏保存', () => {
  const { render } = mount();
  const form = makeForm(SAFE_VALUE, { writable: false, status: 'unavailable' });
  const element = render.component({ view: 'page', form });
  const tree = element.type(element.props);
  assert.ok(
    collect(tree, (n) => typeof n.props.children === 'string' && n.props.children.includes('不可写')).length > 0,
    '应提示配置不可写',
  );
  const inputs = collect(tree, (n) => n.type === 'input' || n.type === 'select');
  assert.ok(inputs.length > 0 && inputs.every((n) => n.props.disabled === true), '控件全部禁用');
  assert.equal(collect(tree, (n) => n.type === 'button').length, 0, '只读时没有保存按钮');
});

test('越界初值视为无效：保存禁用并给出行内提示', () => {
  const { render } = mount();
  const form = makeForm({ ...SAFE_VALUE, durationMs: 50 });
  const element = render.component({ view: 'page', form });
  const tree = element.type(element.props);
  const save = collect(tree, (n) => n.type === 'button').find((n) => n.props.children === '保存');
  assert.ok(save, '保存按钮存在');
  assert.equal(save.props.disabled, true, '越界值不允许提交');
  assert.ok(
    collect(tree, (n) => typeof n.props.children === 'string' && n.props.children.includes('请填')).length > 0,
    '应给出范围提示',
  );
});
