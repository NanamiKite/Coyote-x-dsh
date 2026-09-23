"use strict";
const { EventEmitter } = require("events");

/*
 * 模拟控制器：接口与 CoyoteController 对齐，
 * 用于 npm test 与无硬件环境（TENTACLE_BACKEND=mock）。
 *
 * 记录全部写入到 this.writes，方便断言：
 *   ["S", a, b]      setIntensity
 *   ["A", x, y, z]   setWaveformA
 *   ["B", x, y, z]   setWaveformB
 *   ["W", fa, fb]    setWaveformWindow（V3）
 *   ["STOP"]         emergencyStop
 */
class MockController extends EventEmitter {
  constructor({ version = 2, battery = 87 } = {}) {
    super();
    this.version = version;
    this.connected = false;
    this.connecting = false;
    this.scanning = false;
    this.battery = battery;
    this.channelA = 0;
    this.channelB = 0;
    this.active = false;
    this.writes = [];
    this.connection = { state: "idle", message: "模拟后端未连接", error: "", startedAt: 0 };
    this.pwmAB2 = null;
    this.pwmA34 = null;
    this.pwmB34 = null;
    this.v3Write = null;
    this.v3Notify = null;
    this.pulseTimer = null;
    this.waveformRefreshTimer = null;
    this.failNextWrite = null; // 测试注入：下一次写入抛错
  }

  _connectionStatus(state, message, error = "") {
    this.connection = { ...this.connection, state, message, error };
    this.emit("connectionChanged", this.connection);
  }

  async scanDevices() {
    if (this.connected || this.connecting) throw new Error("设备正在连接或扫描中");
    return [{ id: "mock-coyote", name: "MOCK COYOTE V2", version: 2 }];
  }

  cancelSelection() {}

  async connect(deviceId) {
    if (this.connected) return;
    this.connecting = true;
    this._connectionStatus("connecting", "正在连接模拟设备");
    try {
      await new Promise(r => setTimeout(r, 5));
      this.connected = true;
      this._connectionStatus("connected", "已连接 MOCK COYOTE V2（模拟后端）");
      this.emit("intensityChanged");
    } finally {
      this.connecting = false;
    }
  }

  async readBattery() {
    if (!this.connected) throw new Error("Coyote 未连接");
    return this.battery;
  }

  _maybeFail() {
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
  }

  async setIntensity(a, b) {
    if (!this.connected) throw new Error("Coyote 未连接");
    this._maybeFail();
    a = Math.max(0, Math.min(200, Math.round(a)));
    b = Math.max(0, Math.min(200, Math.round(b)));
    this.channelA = a;
    this.channelB = b;
    this.active = a > 0 || b > 0;
    this.writes.push(["S", a, b]);
    this.emit("intensityChanged");
  }

  async setWaveformA(x, y, z) {
    if (!this.connected) throw new Error("Coyote 未连接");
    this._maybeFail();
    this.writes.push(["A", x, y, z]);
    this.active = true;
  }

  async setWaveformB(x, y, z) {
    if (!this.connected) throw new Error("Coyote 未连接");
    this._maybeFail();
    this.writes.push(["B", x, y, z]);
    this.active = true;
  }

  async setWaveformWindow(framesA, framesB) {
    if (!this.connected || this.version !== 3) throw new Error("V3 主机未连接");
    this._maybeFail();
    this.writes.push(["W", framesA, framesB]);
    this.active = true;
  }

  async clearWaveforms() {
    if (!this.connected) return;
    if (this.version === 3) this.writes.push(["W", null, null]);
    else {
      this.writes.push(["A", 0, 0, 0]);
      this.writes.push(["B", 0, 0, 0]);
    }
  }

  _clearAllTimers() {
    if (this.pulseTimer) { clearTimeout(this.pulseTimer); this.pulseTimer = null; }
    if (this.waveformRefreshTimer) { clearInterval(this.waveformRefreshTimer); this.waveformRefreshTimer = null; }
  }

  async emergencyStop() {
    this._clearAllTimers();
    this.channelA = 0;
    this.channelB = 0;
    this.active = false;
    if (this.connected) this.writes.push(["STOP"]);
    this.emit("intensityChanged");
  }

  async disconnect() {
    this._clearAllTimers();
    this.connected = false;
    this.channelA = 0;
    this.channelB = 0;
    this.active = false;
    this.battery = null;
    this._connectionStatus("idle", "已断开模拟设备");
  }

  dispose() {
    this._clearAllTimers();
    this.connected = false;
  }
}

module.exports = { MockController };
