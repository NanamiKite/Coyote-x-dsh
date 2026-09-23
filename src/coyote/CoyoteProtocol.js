class CoyoteProtocol {
  /*
   * PWM_AB2
   *
   * 23-22 : reserved
   * 21-11 : A
   * 10-0  : B
   *
   * A / B 均为 11 bit：
   *
   * 0 ~ 2047
   */
  encodeIntensity(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      throw new Error("Intensity must be integer");
    }

    if (a < 0 || a > 0x7ff || b < 0 || b > 0x7ff) {
      throw new Error("Intensity range: 0..2047");
    }

    /*
     * 23-22 : reserved
     * 21-11 : A
     * 10-0  : B
     */

    const value = ((a & 0x7ff) << 11) | (b & 0x7ff);

    /*
     * Coyote PWM_AB2 使用 little-endian。
     */

    return Uint8Array.from([
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
    ]);
  }

  /*
   * PWM_AB2 解码
   */
  decodeIntensity(data) {
    if (!data || data.byteLength !== 3) {
      throw new Error("PWM_AB2 requires 3 bytes");
    }

    const value = (data[0] | (data[1] << 8) | (data[2] << 16)) & 0x3fffff;

    return {
      a: (value >> 11) & 0x7ff,
      b: value & 0x7ff,
    };
  }

  /*
   * V2 波形帧使用 Little-Endian。官方 [1, 9, 20] 示例为 21 01 0A。
   */
  encodeWaveformA(x, y, z) {
    const value = ((z & 0x1f) << 15) | ((y & 0x3ff) << 5) | (x & 0x1f);
    return Uint8Array.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
  }

  /*
   * A / B 的字节格式相同。
   */
  encodeWaveformB(x, y, z) {
    return this.encodeWaveformA(x, y, z);
  }
}

module.exports = {
  CoyoteProtocol,
};
