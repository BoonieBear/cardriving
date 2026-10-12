/**
 * @vitest-environment jsdom
 *
 * 触觉反馈测试
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Haptics, HAPTIC_PATTERNS, gearHapticPattern } from './Haptics';

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).vibrate;
});

describe('Haptics — 振动配方', () => {
  it('前进挡使用「入挡」短促节奏', () => {
    expect(gearHapticPattern(1)).toEqual([...HAPTIC_PATTERNS.gearEngage]);
    expect(gearHapticPattern(5)).toEqual([...HAPTIC_PATTERNS.gearEngage]);
  });

  it('空挡与倒挡使用更明显的顿挫节奏', () => {
    expect(gearHapticPattern(0)).toEqual([...HAPTIC_PATTERNS.gearNeutral]);
    expect(gearHapticPattern(-1)).toEqual([...HAPTIC_PATTERNS.gearNeutral]);
  });

  it('返回的是副本，修改结果不会污染配方常量', () => {
    const p = gearHapticPattern(1);
    p.push(9999);
    expect(gearHapticPattern(1)).toEqual([...HAPTIC_PATTERNS.gearEngage]);
  });
});

describe('Haptics — 环境降级', () => {
  it('浏览器不支持 vibrate 时安全返回 false', () => {
    expect(Haptics.isSupported()).toBe(false);
    const h = new Haptics();
    expect(h.vibrate(10)).toBe(false);
    expect(h.gearShift(2)).toBe(false);
    expect(h.pedalBottom()).toBe(false);
    expect(h.calibrateDone()).toBe(false);
  });

  it('支持 vibrate 时传入正确节奏并返回 true', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    (navigator as unknown as Record<string, unknown>).vibrate = vibrate;
    expect(Haptics.isSupported()).toBe(true);

    const h = new Haptics();
    expect(h.gearShift(3)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([...HAPTIC_PATTERNS.gearEngage]);

    expect(h.pedalBottom()).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([...HAPTIC_PATTERNS.pedalBottom]);
  });

  it('关闭后不再振动', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    (navigator as unknown as Record<string, unknown>).vibrate = vibrate;

    const h = new Haptics();
    h.setEnabled(false);
    expect(h.isEnabled()).toBe(false);
    expect(h.vibrate(10)).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('vibrate 抛异常时不崩溃', () => {
    (navigator as unknown as Record<string, unknown>).vibrate = () => {
      throw new Error('vibration blocked');
    };
    const h = new Haptics();
    expect(h.vibrate(10)).toBe(false);
  });
});
