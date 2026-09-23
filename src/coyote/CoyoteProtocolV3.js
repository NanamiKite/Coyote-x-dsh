"use strict";

const OFF = Object.freeze({ frequency: [0,0,0,0], strength: [0,0,0,101] });

function byte(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${label} 范围必须是 0–${max}`);
  return value;
}

class CoyoteProtocolV3 {
  // The V3 frequency is a period in milliseconds, compressed into one byte.
  static periodToByte(period) {
    if (!Number.isFinite(period)) throw new Error("无效的 V3 波形周期");
    const value = Math.max(10, Math.min(1000, Math.round(period)));
    return Math.max(10, Math.min(240, Math.floor(value <= 100 ? value : value <= 600 ? (value - 100) / 5 + 100 : (value - 600) / 10 + 200)));
  }

  static fromV2Frame(frame) {
    if (!Array.isArray(frame) || frame.length !== 3 || frame.some(v => !Number.isInteger(v))) throw new Error("无效的波形帧");
    const [x,y,z] = frame;
    if (x < 0 || x > 31 || y < 0 || y > 1023 || z < 0 || z > 15) throw new Error("波形帧超出范围");
    return { frequency: this.periodToByte(x + y), strength: x + y === 0 ? 0 : z * 5 };
  }

  static encodeB0({ sequence = 0, methodA = 0, methodB = 0, intensityA = 0, intensityB = 0, a = OFF, b = OFF } = {}) {
    byte(sequence, 15, "序列号"); byte(methodA, 3, "A 强度方式"); byte(methodB, 3, "B 强度方式");
    byte(intensityA, 200, "A 强度"); byte(intensityB, 200, "B 强度");
    const output = Uint8Array.of(0xB0, (sequence << 4) | (methodA << 2) | methodB, intensityA, intensityB);
    const packet = new Uint8Array(20);
    packet.set(output);
    for (const [wave, offset] of [[a,4],[b,12]]) {
      if (!Array.isArray(wave.frequency) || wave.frequency.length !== 4 || !Array.isArray(wave.strength) || wave.strength.length !== 4) throw new Error("V3 每通道必须有 4 组波形");
      for (let i = 0; i < 4; i++) {
        byte(wave.frequency[i], 255, "波形频率"); byte(wave.strength[i], 255, "波形强度");
        packet[offset+i] = wave.frequency[i];
        packet[offset+4+i] = wave.strength[i];
      }
    }
    return packet;
  }

  static encodeBF({ limitA = 200, limitB = 200, frequencyBalanceA = 128, frequencyBalanceB = 128, strengthBalanceA = 128, strengthBalanceB = 128 } = {}) {
    return Uint8Array.of(0xBF, byte(limitA,200,"A 软上限"), byte(limitB,200,"B 软上限"),
      byte(frequencyBalanceA,255,"A 频率平衡"), byte(frequencyBalanceB,255,"B 频率平衡"),
      byte(strengthBalanceA,255,"A 强度平衡"), byte(strengthBalanceB,255,"B 强度平衡"));
  }

  static decodeB1(data) {
    const bytes = data instanceof DataView ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data;
    if (!bytes || bytes.length !== 4 || bytes[0] !== 0xB1) throw new Error("无效的 V3 B1 强度通知");
    if (bytes[2] > 200 || bytes[3] > 200) throw new Error("V3 B1 强度超出范围");
    return { sequence: bytes[1], a: bytes[2], b: bytes[3] };
  }
}

module.exports = { CoyoteProtocolV3, OFF };
