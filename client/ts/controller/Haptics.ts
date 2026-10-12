/**
 * 触觉反馈（手机振动）
 * 把「入挡 / 踩到底 / 校准」这些机械动作翻译成振动节奏，
 * 手机上有真实的「咔哒」顿挫感；桌面或不支持的浏览器自动降级为无操作。
 */

/** 机械动作 → 振动节奏（毫秒） */
export const HAPTIC_PATTERNS = {
  /** 入挡：短促的一声金属咔哒 */
  gearEngage: [12],
  /** 空挡 / 倒挡：带一次停顿的两段顿挫 */
  gearNeutral: [10, 28, 16],
  /** 踏板踩到底：稍长的阻尼反馈 */
  pedalBottom: [16],
  /** 踏板回位 */
  pedalRelease: [7],
  /** 陀螺仪校准完成 */
  calibrate: [10, 36, 10],
} as const;

/**
 * 挡位 → 振动节奏（纯函数，便于测试）
 */
export function gearHapticPattern(gear: number): number[] {
  if (gear === -1 || gear === 0) return [...HAPTIC_PATTERNS.gearNeutral];
  return [...HAPTIC_PATTERNS.gearEngage];
}

export class Haptics {
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 当前环境是否支持振动 */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === 'function';
  }

  /** 触发一次振动，返回是否真的触发成功 */
  vibrate(pattern: number | number[]): boolean {
    if (!this.enabled) return false;
    if (!Haptics.isSupported()) return false;
    try {
      const result = (navigator as Navigator & { vibrate: (p: number | number[]) => boolean }).vibrate(pattern);
      return result === true;
    } catch {
      return false;
    }
  }

  gearShift(gear: number): boolean {
    return this.vibrate(gearHapticPattern(gear));
  }

  pedalBottom(): boolean {
    return this.vibrate([...HAPTIC_PATTERNS.pedalBottom]);
  }

  pedalRelease(): boolean {
    return this.vibrate([...HAPTIC_PATTERNS.pedalRelease]);
  }

  calibrateDone(): boolean {
    return this.vibrate([...HAPTIC_PATTERNS.calibrate]);
  }
}
