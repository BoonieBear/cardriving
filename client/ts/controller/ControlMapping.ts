/**
 * 控制器输入 → 仪表显示的映射（纯函数，便于单测）
 * 机械感的关键：所有「角度/行程/挡位」的换算都集中在这里，UI 只负责渲染。
 */
import { clamp } from '../../../shared/utils/math.js';

/** 方向盘最大转角（度），对应满舵 */
export const MAX_WHEEL_DEGREES = 120;

/** 陀螺仪满舵对应的真实前轮转角（度），与 Gyroscope.maxTiltAngle 一致 */
export const MAX_STEER_DEGREES = 35;

/**
 * 归一化转向量 → 方向盘旋转角度（度）
 * steer = -1 左满舵，+1 右满舵
 */
export function steerToWheelDegrees(steer: number, maxDegrees: number = MAX_WHEEL_DEGREES): number {
  return clamp(steer, -1, 1) * maxDegrees;
}

/** 归一化转向量 → 前轮转角（度，显示用） */
export function steerToDisplayDegrees(steer: number): number {
  return Math.round(clamp(steer, -1, 1) * MAX_STEER_DEGREES);
}

/** 归一化转向量 → 百分比（-100..100） */
export function steerToPercent(steer: number): number {
  return Math.round(clamp(steer, -1, 1) * 100);
}

/** 带符号的角度文本，例如 "+35°" / "0°" / "-12°" */
export function signedDegreesText(degrees: number): string {
  const v = Math.round(degrees);
  return `${v > 0 ? '+' : ''}${v}°`;
}

/**
 * 踏板行程：触点 Y 坐标 → [0,1]（轨道底部为 0，顶部为 1）
 */
export function pedalTravelFromClientY(clientY: number, trackTop: number, trackHeight: number): number {
  if (!(trackHeight > 0)) return 0;
  return clamp(1 - (clientY - trackTop) / trackHeight, 0, 1);
}

/** 踏板百分比文本，例如 "42%" */
export function pedalPercentText(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

/** 挡位显示文本 */
export function gearToText(gear: number): string {
  if (gear === -1) return 'R';
  if (gear === 0) return 'N';
  return String(gear);
}
