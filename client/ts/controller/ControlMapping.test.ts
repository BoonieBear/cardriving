/**
 * 控制器映射纯函数测试
 */
import { describe, it, expect } from 'vitest';
import {
  steerToWheelDegrees,
  steerToDisplayDegrees,
  steerToPercent,
  signedDegreesText,
  pedalTravelFromClientY,
  pedalPercentText,
  gearToText,
  MAX_WHEEL_DEGREES,
} from './ControlMapping';

describe('ControlMapping — 方向盘角度', () => {
  it('steer=0 时方向盘不转', () => {
    expect(steerToWheelDegrees(0)).toBe(0);
  });

  it('满舵映射到 ±MAX_WHEEL_DEGREES', () => {
    expect(steerToWheelDegrees(1)).toBe(MAX_WHEEL_DEGREES);
    expect(steerToWheelDegrees(-1)).toBe(-MAX_WHEEL_DEGREES);
    expect(steerToWheelDegrees(0.5)).toBeCloseTo(MAX_WHEEL_DEGREES / 2, 10);
  });

  it('超出 [-1,1] 的输入被夹紧', () => {
    expect(steerToWheelDegrees(3)).toBe(MAX_WHEEL_DEGREES);
    expect(steerToWheelDegrees(-3)).toBe(-MAX_WHEEL_DEGREES);
  });

  it('可自定义最大转角', () => {
    expect(steerToWheelDegrees(1, 90)).toBe(90);
  });

  it('前轮转角显示为 ±35° 的整数', () => {
    expect(steerToDisplayDegrees(0)).toBe(0);
    expect(steerToDisplayDegrees(1)).toBe(35);
    expect(steerToDisplayDegrees(-1)).toBe(-35);
    expect(steerToDisplayDegrees(0.5)).toBe(18);
  });

  it('steerToPercent 输出 -100..100 整数', () => {
    expect(steerToPercent(0)).toBe(0);
    expect(steerToPercent(1)).toBe(100);
    expect(steerToPercent(-0.25)).toBe(-25);
    expect(steerToPercent(2)).toBe(100);
  });

  it('signedDegreesText 带符号且四舍五入', () => {
    expect(signedDegreesText(0)).toBe('0°');
    expect(signedDegreesText(35)).toBe('+35°');
    expect(signedDegreesText(-12)).toBe('-12°');
    expect(signedDegreesText(4.6)).toBe('+5°');
  });
});

describe('ControlMapping — 踏板行程', () => {
  it('轨道顶部为满行程，底部为 0', () => {
    expect(pedalTravelFromClientY(0, 0, 200)).toBe(1);
    expect(pedalTravelFromClientY(200, 0, 200)).toBe(0);
    expect(pedalTravelFromClientY(100, 0, 200)).toBeCloseTo(0.5, 10);
  });

  it('超出轨道范围被夹紧到 [0,1]', () => {
    expect(pedalTravelFromClientY(-50, 0, 200)).toBe(1);
    expect(pedalTravelFromClientY(999, 0, 200)).toBe(0);
  });

  it('考虑轨道在屏幕上的偏移', () => {
    expect(pedalTravelFromClientY(300, 300, 100)).toBe(1);
    expect(pedalTravelFromClientY(400, 300, 100)).toBe(0);
  });

  it('高度为 0 时不产生 NaN', () => {
    expect(pedalTravelFromClientY(50, 0, 0)).toBe(0);
    expect(Number.isNaN(pedalTravelFromClientY(50, 0, 0))).toBe(false);
  });

  it('pedalPercentText 显示百分比', () => {
    expect(pedalPercentText(0)).toBe('0%');
    expect(pedalPercentText(0.426)).toBe('43%');
    expect(pedalPercentText(1)).toBe('100%');
    expect(pedalPercentText(5)).toBe('100%');
  });
});

describe('ControlMapping — 挡位文本', () => {
  it('倒挡 / 空挡 / 前进挡', () => {
    expect(gearToText(-1)).toBe('R');
    expect(gearToText(0)).toBe('N');
    expect(gearToText(1)).toBe('1');
    expect(gearToText(5)).toBe('5');
  });
});
