/**
 * 相机管理器（阶段二）
 *
 * 统一管理三种相机视角：
 *  - cockpit  第一人称车内视角
 *  - chase    车尾跟随第三人称视角（平滑滞后跟随）
 *  - top      上帝俯视全局视角
 *
 * 职责：
 *  1. 视角切换（循环 / 直接设置）与合法性校验；
 *  2. 由车辆位姿求解目标机位（机位预设表）；
 *  3. 位置 / 朝向 / 俯仰的平滑插值（与帧率无关的指数衰减，跨 ±π 不横跳）；
 *  4. 碰撞避让防穿模（相机始终高于所在地形，且过渡插值中也不沉入地面）。
 *
 * 纯逻辑模块：不依赖 DOM、不依赖 Three.js，也不直接绘制，
 * 由 Software3DRenderer 每帧调用 update() 取机位。便于单元测试与后续替换渲染器。
 */
import { clamp, lerp, normalizeAngle } from '../../../shared/utils/math.js';

/** 三种相机视角：第一人称车内 / 车尾跟随第三人称 / 上帝俯视全局 */
export type CameraMode = 'cockpit' | 'chase' | 'top';

/** 快捷键循环顺序：车内 → 车尾 → 俯视 */
export const CAMERA_MODES: readonly CameraMode[] = ['cockpit', 'chase', 'top'] as const;

/** 视角中文名（调试面板 / HUD 显示） */
export const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  cockpit: '第一人称车内',
  chase: '车尾跟随',
  top: '上帝俯视',
};

/** 视角简称（小屏显示） */
export const CAMERA_MODE_SHORT: Record<CameraMode, string> = {
  cockpit: '车内',
  chase: '车尾',
  top: '俯视',
};

export function isCameraMode(value: unknown): value is CameraMode {
  return value === 'cockpit' || value === 'chase' || value === 'top';
}

/** 按步进循环切换视角：cockpit → chase → top → cockpit */
export function cycleCameraMode(current: CameraMode, step: number = 1): CameraMode {
  const idx = CAMERA_MODES.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = (((base + step) % CAMERA_MODES.length) + CAMERA_MODES.length) % CAMERA_MODES.length;
  return CAMERA_MODES[next];
}

/**
 * 相机机位预设。
 *
 *  - behind     ：机位在车辆正后方的水平距离（米，负值表示在车头前方）
 *  - height     ：机位相对车下地面的高度（米）
 *  - pitch      ：俯仰角（弧度，负值向下看）
 *  - clearance  ：防穿模最小离地高度（米）
 *  - followRate / yawRate / pitchRate：位置 / 朝向 / 俯仰的平滑速率（1/s）
 */
export interface CameraPreset {
  behind: number;
  height: number;
  pitch: number;
  clearance: number;
  followRate: number;
  yawRate: number;
  pitchRate: number;
}

export const CAMERA_PRESETS: Record<CameraMode, CameraPreset> = {
  // 第一人称车内：机位在座舱内，跟随极紧，避免眩晕
  cockpit: { behind: -0.35, height: 1.18, pitch: -0.03, clearance: 0.55, followRate: 22, yawRate: 22, pitchRate: 10 },
  // 车尾跟随：第三人称，位置明显滞后于车辆（平滑滞后跟随）
  chase: { behind: 6.5, height: 3.2, pitch: -0.16, clearance: 0.9, followRate: 10, yawRate: 12, pitchRate: 6 },
  // 上帝俯视：高机位大俯角，看清全局赛道走向
  top: { behind: 13, height: 30, pitch: -1.02, clearance: 2.5, followRate: 6, yawRate: 5, pitchRate: 4 },
};

/** 相机状态（世界坐标 + 朝向 + 俯仰） */
export interface CameraState {
  mode: CameraMode;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** 地形高度函数（防穿模用） */
export type TerrainHeightFn = (x: number, z: number) => number;

/** 相机离地高度低于该值时视为「在车内」，渲染器据此不绘制本车车身 */
export const COCKPIT_HEIGHT_MAX = 2.1;

export class CameraManager {
  private mode: CameraMode = 'chase';
  private initialized = false;

  private x = 0;
  private y = 0;
  private z = 0;
  private yaw = 0;
  private pitch = 0;

  /** 上一帧实际使用的俯仰角（供渲染器做天空/地面的视觉过渡） */
  private lastPitch = 0;

  /** 切换相机视角（非法值被忽略） */
  setMode(mode: CameraMode): void {
    if (!isCameraMode(mode)) return;
    this.mode = mode;
  }

  /** 当前相机视角 */
  getMode(): CameraMode {
    return this.mode;
  }

  /** 当前机位预设 */
  getPreset(): CameraPreset {
    return CAMERA_PRESETS[this.mode];
  }

  /** 循环切换相机视角（快捷键用），返回切换后的视角 */
  cycle(step: number = 1): CameraMode {
    this.mode = cycleCameraMode(this.mode, step);
    return this.mode;
  }

  /** 当前平滑后的相机状态 */
  getState(): CameraState {
    return {
      mode: this.mode,
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  /** 复位平滑状态：下一帧直接吸附到目标机位（车辆复位 / 传送后调用） */
  reset(): void {
    this.initialized = false;
  }

  /**
   * 求解本帧机位：先算目标机位，再做平滑插值与防穿模。
   *
   * @param carX/carZ 车辆世界坐标
   * @param heading   车头朝向（弧度）
   * @param dt        时间步长（秒）
   * @param terrainHeight 地形高度函数（防穿模）
   */
  update(
    carX: number,
    carZ: number,
    heading: number,
    dt: number,
    terrainHeight: TerrainHeightFn,
  ): CameraState {
    const preset = CAMERA_PRESETS[this.mode];
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const carGroundY = terrainHeight(carX, carZ);

    // 目标机位：车辆位置沿 −前向 偏移 behind 米，抬高 height 米
    const targetX = carX - sinH * preset.behind;
    const targetZ = carZ - cosH * preset.behind;
    let targetY = carGroundY + preset.height;

    // 防穿模：相机所在位置的地形高度 + 最小离地间隙
    const minY = terrainHeight(targetX, targetZ) + preset.clearance;
    if (targetY < minY) targetY = minY;

    if (!this.initialized) {
      // 首帧（或复位后）直接吸附，避免从原点飞过来
      this.x = targetX;
      this.y = targetY;
      this.z = targetZ;
      this.yaw = heading;
      this.pitch = preset.pitch;
      this.initialized = true;
    }

    const step = Math.max(dt, 0);
    // 位置平滑（指数衰减，与帧率无关）
    const kPos = 1 - Math.exp(-step * preset.followRate);
    this.x = lerp(this.x, targetX, kPos);
    this.y = lerp(this.y, targetY, kPos);
    this.z = lerp(this.z, targetZ, kPos);

    // 朝向平滑（走最短弧，跨越 ±π 不横跳）
    const kYaw = 1 - Math.exp(-step * preset.yawRate);
    this.yaw = normalizeAngle(this.yaw + normalizeAngle(heading - this.yaw) * kYaw);

    // 俯仰平滑
    const kPitch = 1 - Math.exp(-step * preset.pitchRate);
    this.pitch = lerp(this.pitch, preset.pitch, kPitch);

    // 平滑之后再兜底一次，防止插值过程中短暂沉入地面
    const minSmoothY = terrainHeight(this.x, this.z) + preset.clearance * 0.5;
    if (this.y < minSmoothY) this.y = minSmoothY;

    this.lastPitch = this.pitch;
    return this.getState();
  }

  /**
   * 俯视程度 [0,1]：由当前俯仰角换算，供渲染器把天空/远山平滑过渡成全屏地面。
   * 使用上一帧实际俯仰角，因此视角切换过程中背景不会硬切。
   */
  topDownBlend(): number {
    return clamp((-this.lastPitch - 0.55) / 0.35, 0, 1);
  }

  /** 是否处于车内视角（相机贴近座舱） */
  isInsideCar(terrainHeight: TerrainHeightFn): boolean {
    return this.y - terrainHeight(this.x, this.z) < COCKPIT_HEIGHT_MAX;
  }
}
