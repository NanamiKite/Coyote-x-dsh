"use strict";

/*
 * 安全钳制层，独立于 MCP 工具与 UI。
 *
 * 即使绕过上层参数校验，
 * 这里仍然保证：
 *
 * App 挡位 0 ~ 200
 * 协议 S   0 ~ 2047（11 bit）
 * 时长     0 ~ maxDurationMs
 */
class CoyoteSafety {
  constructor() {
    /*
     * App 界面的强度挡位：0 ~ 200
     * 官方 App 每增加 1 挡，协议中的实际 S 增加 7。
     */
    this.maxIntensity = 200;

    /*
     * App 挡位与协议 S 的倍率：S = AppLevel × 7
     */
    this.intensityScale = 7;

    /*
     * 协议 S 的实际最大值。PWM_AB2 使用 11 bit：0 ~ 2047。
     */
    this.maxProtocolIntensity = 2047;

    this.maxDuration = 5000;
  }

  /*
   * 处理 App 强度挡位，返回仍然是 App 挡位。
   */
  intensity(value) {
    value = Number(value);

    if (!Number.isFinite(value)) {
      throw new Error("Intensity must be a number");
    }

    value = Math.round(value);

    return Math.max(0, Math.min(this.maxIntensity, value));
  }

  /*
   * App 挡位 → 协议 S（0 → 0，200 → 1400）
   */
  intensityToProtocol(value) {
    value = this.intensity(value);

    const protocolValue = value * this.intensityScale;

    if (
      !Number.isInteger(protocolValue) ||
      protocolValue < 0 ||
      protocolValue > this.maxProtocolIntensity
    ) {
      throw new Error("Protocol intensity out of range");
    }

    return protocolValue;
  }

  /*
   * 协议 S → App 挡位（四舍五入，防止非 7 倍数出现小数）
   */
  protocolToIntensity(value) {
    value = Number(value);

    if (!Number.isFinite(value)) {
      throw new Error("Protocol intensity must be a number");
    }

    value = Math.round(value);

    if (value < 0 || value > this.maxProtocolIntensity) {
      throw new Error("Protocol intensity range: 0..2047");
    }

    const appValue = Math.round(value / this.intensityScale);

    return Math.max(0, Math.min(this.maxIntensity, appValue));
  }

  duration(value) {
    value = Number(value);

    if (!Number.isFinite(value)) {
      throw new Error("Duration must be a number");
    }

    return Math.max(0, Math.min(this.maxDuration, Math.round(value)));
  }
}

module.exports = {
  CoyoteSafety,
};
