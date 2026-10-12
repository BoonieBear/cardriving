/**
 * 辅助驾驶 / 自动驾驶系统
 *
 * 三档驾驶模式：
 *  - manual   手动：完全由玩家（手机陀螺仪 / 键盘）操控
 *  - assist   辅助驾驶：系统接管油门、自动换挡、车道保持与避障；
 *                       玩家仍可用刹车减速（刹车优先）
 *  - auto     全自动驾驶：系统全部接管，自动加减速过弯 + 车道保持 + 避障 + 自动换挡
 *
 * 设计约束（遵循 DEV.md）：
 *  1. 所有运算只在大屏主机端执行，手机端只负责发送模式意图与展示。
 *  2. 纯函数式核心：compute() 不修改任何外部状态（除自身平滑量），便于测试。
 *  3. 输出仍是标准 ControlPacket，不需要改动手机→大屏的操控包协议。
 */
import { clamp } from '../../../shared/utils/math.js';
import { perpRight } from '../../../shared/utils/math.js';
import type { Track } from '../core/Track.js';
import { getGearRatio } from './CarPhysics.js';
import type { CarState } from './CarPhysics.js';
import type { ControlPacket } from '../../../shared/protocol.js';

// ========== 驾驶模式 ==========

/** 驾驶模式标识 */
export type DriveMode = 'manual' | 'assist' | 'auto';

/** 参与操控接管的模式（辅助驾驶 + 全自动驾驶） */
export const AUTONOMOUS_MODES: readonly DriveMode[] = ['assist', 'auto'] as const;

/** 支持的驾驶模式列表（顺序与 UI 按钮一致） */
export const DRIVE_MODES: readonly DriveMode[] = ['manual', 'assist', 'auto'] as const;

/** 模式中文名 */
export const DRIVE_MODE_LABELS: Record<DriveMode, string> = {
  manual: '手动驾驶',
  assist: '辅助驾驶',
  auto: '全自动驾驶',
};

/** 模式简称（手机小屏用） */
export const DRIVE_MODE_SHORT: Record<DriveMode, string> = {
  manual: '手动',
  assist: '辅助',
  auto: '自动',
};

export function isDriveMode(value: unknown): value is DriveMode {
  return value === 'manual' || value === 'assist' || value === 'auto';
}

/** 校验并归一化外部传入的模式值，非法值回退到 manual */
export function normalizeDriveMode(value: unknown): DriveMode {
  return isDriveMode(value) ? value : 'manual';
}

/** 按步进循环切换模式：manual → assist → auto → manual */
export function cycleDriveMode(current: DriveMode, step: number = 1): DriveMode {
  const list = DRIVE_MODES;
  const idx = list.indexOf(current);
  const base = idx < 0 ? 0 : idx;
  const next = (((base + step) % list.length) + list.length) % list.length;
  return list[next];
}

/** 该模式是否由系统接管操控 */
export function isAutonomousMode(mode: DriveMode): boolean {
  return mode === 'assist' || mode === 'auto';
}

/**
 * 断线接管时使用的驾驶模式。
 *
 * 控制器（手机）掉线后不再「缓缓停车」，而是交给全自动驾驶继续沿赛道行驶，
 * 避免车辆停在赛道中间。集中成常量便于测试与后续调整。
 */
export const DISCONNECT_TAKEOVER_MODE: DriveMode = 'auto';

/**
 * 解析本帧实际生效的驾驶模式（纯函数，便于测试）。
 *
 * 优先级（后者覆盖前者）：
 *  1. 玩家选择的模式；
 *  2. 手动模式下吃到「自动驾驶」技能道具 → 临时提升为辅助驾驶；
 *  3. 控制器断开 → 强制全自动驾驶接管（最高优先级）。
 */
export function resolveActiveDriveMode(params: {
  /** 玩家选择的模式 */
  driveMode: DriveMode;
  /** 是否吃到临时自动驾驶道具 */
  hasAutoDriveSkill: boolean;
  /** 控制器是否处于断开接管状态 */
  disconnected: boolean;
}): DriveMode {
  if (params.disconnected) return DISCONNECT_TAKEOVER_MODE;
  if (params.driveMode === 'manual' && params.hasAutoDriveSkill) return 'assist';
  return params.driveMode;
}

// ========== 感知数据 ==========

export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

/** 朝向某个目标点的感知结果 */
export interface TargetPerception {
  /** 目标点（通常是前视点） */
  x: number;
  z: number;
  /** 目标点相对车头的前向距离（米，负值表示在车后） */
  forwardDist: number;
  /** 目标点相对车头中心的横向偏移（米，正=车头右侧） */
  lateralOffset: number;
  /** 车头到目标点的连线角 */
  bearing: number;
}

/** 避障候选方案 */
export interface AvoidancePlan {
  /** 是否检测到必须避让的障碍物 */
  active: boolean;
  /** 横向避让偏移量（米，正=向右） */
  lateralOffset: number;
  /** 建议的速度上限（m/s），障碍物很近时会降速 */
  speedLimit: number;
  /** 触发避让的最近障碍物距离（米），未触发为 Infinity */
  nearestDistance: number;
}

// ========== 自动驾驶参数 ==========

export interface AutoPilotConfig {
  /** 基础前视距离（米），随车速增大 */
  baseLookAhead: number;
  /** 车速 → 前视距离增益（秒） */
  lookAheadTime: number;
  /** 最大前视距离（米） */
  maxLookAhead: number;

  /** 转向比例增益（弧度误差 → steer） */
  steerGain: number;
  /** 横向偏移增益（米 → steer） */
  lateralGain: number;
  /** 航向误差阻尼 */
  headingDamp: number;

  /** 全自动驾驶：弯道目标通过速度（m/s） */
  curveSpeed: number;
  /** 全自动驾驶：极速上限（m/s） */
  cruiseSpeed: number;
  /** 全自动驾驶：出弯加速增益 */
  curveAccelGain: number;

  /** 辅助驾驶：油门强度 */
  assistThrottle: number;

  /** 换挡：升挡转速阈值 [0,1] */
  shiftUpRpm: number;
  /** 换挡：降挡转速阈值 [0,1] */
  shiftDownRpm: number;
  /** 换挡最小间隔（秒），防止连续跳挡 */
  shiftCooldown: number;

  /** 车道保持容差（米），偏离小于该值不额外修正 */
  laneTolerance: number;
  /** 自动刹车强度上限 [0,1] */
  maxAutoBrake: number;

  /**
   * 靠右行驶的横向目标偏移（米）。
   *
   * 约定：正 = 车辆位于赛道中心线的右侧（世界坐标下沿 perpRight 方向）。
   * 0 表示压着中心线走（旧行为）；右行交通应取正的小值，
   * 让车稳定跑在「右车道」而不是骑在中心线上。
   */
  laneOffset: number;

  /** 避障：探测距离（米） */
  avoidLookAhead: number;
  /** 避障：障碍物安全间距（米，含车身与障碍半径之外） */
  avoidMargin: number;
  /** 避障：最大横向避让距离（米） */
  maxAvoidOffset: number;
  /** 避障：开始减速的距离（米） */
  avoidBrakeDistance: number;
}

export const DEFAULT_AUTOPILOT_CONFIG: AutoPilotConfig = {
  baseLookAhead: 10,
  lookAheadTime: 1.1,
  maxLookAhead: 42,

  steerGain: 1.35,
  lateralGain: 0.035,
  headingDamp: 0.25,

  curveSpeed: 19,        // ≈ 68 km/h 过弯
  cruiseSpeed: 44,       // ≈ 158 km/h 直道巡航
  curveAccelGain: 6,

  assistThrottle: 0.72,

  shiftUpRpm: 0.82,
  shiftDownRpm: 0.34,
  shiftCooldown: 0.45,

  laneTolerance: 0.35,
  maxAutoBrake: 0.85,

  // 靠右行驶：12 米宽的路（半宽 6 米），车道中心大致在半宽的一半。
  // 取 2.5 米，既明显偏右、又给避障留出向左借道的余量。
  laneOffset: 2.5,

  avoidLookAhead: 34,
  avoidMargin: 2.2,
  maxAvoidOffset: 3.6,
  avoidBrakeDistance: 16,
};

/**
 * 自动驾驶控制器
 *
 * 纯逻辑模块，不依赖 DOM。GameEngine 每帧调用 compute() 得到实际下发的控制包。
 */
export class AutoPilot {
  public config: AutoPilotConfig;

  /** 上一次输出的自动换挡挡位 */
  private shiftGear: number = 1;
  private shiftTimer: number = 0;

  /** 平滑后的转向输出 */
  private smoothSteer: number = 0;
  /** 平滑后的避让偏移 */
  private smoothAvoid: number = 0;

  constructor(config?: Partial<AutoPilotConfig>) {
    this.config = { ...DEFAULT_AUTOPILOT_CONFIG, ...config };
  }

  /** 重置内部平滑量与挡位状态（换车 / 切换模式时调用） */
  reset(gear?: number): void {
    this.shiftGear = gear ?? 1;
    this.shiftTimer = 0;
    this.smoothSteer = 0;
    this.smoothAvoid = 0;
  }

  /** 当前自动挡位 */
  getGear(): number {
    return this.shiftGear;
  }

  /**
   * 根据车速计算前视距离（米）
   */
  getLookAheadDistance(speed: number): number {
    const cfg = this.config;
    return clamp(
      cfg.baseLookAhead + Math.abs(speed) * cfg.lookAheadTime,
      cfg.baseLookAhead,
      cfg.maxLookAhead,
    );
  }

  /**
   * 计算目标前视点相对车头的感知信息。
   *
   * 约定（与 CarPhysics 一致）：heading=0 朝 +Z，heading 增大朝 +X 旋转。
   * 前向 = (sin h, cos h)，右向 = (cos h, -sin h)。
   */
  perceiveTarget(
    state: Pick<CarState, 'x' | 'z' | 'heading'>,
    targetX: number,
    targetZ: number,
  ): TargetPerception {
    const dx = targetX - state.x;
    const dz = targetZ - state.z;
    const sinH = Math.sin(state.heading);
    const cosH = Math.cos(state.heading);
    return {
      x: targetX,
      z: targetZ,
      forwardDist: dx * sinH + dz * cosH,
      lateralOffset: dx * cosH - dz * sinH,
      bearing: Math.atan2(dx, dz),
    };
  }

  /**
   * 计算前视目标点：沿赛道中心线向前取 lookAhead 米处的点，再向右侧偏移 laneOffset，
   * 使车辆稳定行驶在「右车道」而不是骑在中心线上（右行交通）。
   *
   * 横向偏移用 perpRight 计算，与 Track.nearestPoint 的 lateralOffset 符号相反，
   * 因此这里向外输出的 target 是真正的几何位置，消费方无需关心符号约定。
   */
  getAimPoint(
    track: Track,
    state: Pick<CarState, 'x' | 'z' | 'heading' | 'speed'>,
  ): TargetPerception {
    const near = track.nearestPoint(state.x, state.z);
    const lookAhead = this.getLookAheadDistance(state.speed);
    const target = track.sampleAtDistance(near.distance + lookAhead);
    const lat = this.getLaneOffset(track);
    const perp = perpRight(target.heading);
    return this.perceiveTarget(state, target.x + perp.x * lat, target.z + perp.z * lat);
  }

  /**
   * 当前生效的靠右偏移量（米，正 = 车的右侧）。
   * 自动收窄：窄赛道上不会把车推出路基。
   */
  getLaneOffset(track: Track): number {
    return clamp(this.config.laneOffset, 0, Math.max(0, track.halfWidth * 0.6));
  }

  /**
   * 扫描前方障碍物，给出避让方案。
   *
   * 只考虑位于「前方走廊」内的障碍物（前向距离 > 0 且横向偏移在探测半宽内），
   * 逐个计算需要的横向避让量，取最大的一个作为最终方案。
   */
  planAvoidance(
    state: Pick<CarState, 'x' | 'z' | 'heading' | 'speed'>,
    obstacles: readonly Obstacle[],
    trackHalfWidth: number,
  ): AvoidancePlan {
    const cfg = this.config;
    const carRadius = 1.2;
    const corridorHalf = Math.max(trackHalfWidth * 0.9, cfg.maxAvoidOffset);
    const sinH = Math.sin(state.heading);
    const cosH = Math.cos(state.heading);

    let bestOffset = 0;
    let nearest = Infinity;
    let active = false;

    for (const obs of obstacles) {
      const dx = obs.x - state.x;
      const dz = obs.z - state.z;
      const forward = dx * sinH + dz * cosH;
      if (forward <= 0.5 || forward > cfg.avoidLookAhead) continue;

      const lateral = dx * cosH - dz * sinH;
      const clearance = carRadius + obs.radius + cfg.avoidMargin;
      if (Math.abs(lateral) > corridorHalf + clearance) continue;

      active = true;
      nearest = Math.min(nearest, forward);

      // 从障碍物旁边绕过去：优先往空间更大的一侧让
      const passSide = lateral >= 0 ? -1 : 1;
      // 需要让开的净横向距离
      const need = clearance - Math.abs(lateral);
      const offset = clamp(
        lateral + passSide * need,
        -cfg.maxAvoidOffset,
        cfg.maxAvoidOffset,
      );
      if (Math.abs(offset) > Math.abs(bestOffset)) {
        bestOffset = offset;
      }
    }

    // 障碍物越近，越要提前减速
    let speedLimit = Infinity;
    if (active && nearest < cfg.avoidBrakeDistance) {
      const t = clamp(nearest / cfg.avoidBrakeDistance, 0, 1);
      speedLimit = Math.max(6, 6 + (state.speed) * t);
    }

    return {
      active,
      lateralOffset: bestOffset,
      speedLimit,
      nearestDistance: nearest,
    };
  }

  /**
   * 弯道目标速度：前方采样若干点，取最小曲率半径对应的安全速度。
   * v = sqrt(a_lat * R)，a_lat 由 curveSpeed 与参考半径反推。
   */
  getCornerSpeedLimit(track: Track, distance: number, currentSpeed: number): number {
    const cfg = this.config;
    const step = 12;
    const samples = 6;
    const lookAhead = Math.max(cfg.baseLookAhead, Math.abs(currentSpeed) * 1.6);

    const base = track.sampleAtDistance(distance);
    let minRadius = Infinity;

    for (let i = 1; i <= samples; i++) {
      const d1 = distance + (lookAhead * i) / (samples + 1);
      const d2 = d1 + step;
      const p0 = track.sampleAtDistance(d1);
      const p1 = track.sampleAtDistance(d2);
      // 航向变化量 → 曲率
      let dHeading = p1.heading - p0.heading;
      while (dHeading > Math.PI) dHeading -= 2 * Math.PI;
      while (dHeading < -Math.PI) dHeading += 2 * Math.PI;
      const arc = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (arc < 0.01) continue;
      const curvature = Math.abs(dHeading) / arc;
      if (curvature > 1e-6) {
        minRadius = Math.min(minRadius, 1 / curvature);
      }
    }
    void base;

    // 横向加速度上限：由 curveSpeed 在参考半径（60m）上的表现反推
    const refRadius = 60;
    const maxLateralAccel = (cfg.curveSpeed * cfg.curveSpeed) / refRadius;
    if (!isFinite(minRadius)) return cfg.cruiseSpeed;
    const safe = Math.sqrt(maxLateralAccel * minRadius);
    return clamp(safe, 8, cfg.cruiseSpeed);
  }

  /**
   * 自动换挡：根据转速与车速挑选合适的前进挡。
   * 返回 -1/0 表示不换挡（保持当前挡位）。
   */
  chooseGear(
    currentSpeed: number,
    currentGear: number,
    rpm: number,
    throttle: number,
  ): number {
    const cfg = this.config;
    if (this.shiftTimer > 0) return -1;
    if (currentSpeed < 0.6) {
      // 起步：1 挡
      if (currentGear !== 1) return 1;
      return -1;
    }

    const gearInfo = getGearRatio(currentGear);

    // 升挡：转速接近红线且油门仍有需求
    if (
      gearInfo &&
      currentGear >= 1 &&
      currentGear < 5 &&
      rpm >= cfg.shiftUpRpm &&
      (throttle > 0.05 || currentSpeed > gearInfo.maxSpeed * 0.9)
    ) {
      return currentGear + 1;
    }

    // 降挡：转速过低，动力不足
    if (
      gearInfo &&
      currentGear > 1 &&
      (rpm <= cfg.shiftDownRpm || currentSpeed < gearInfo.minSpeed)
    ) {
      return currentGear - 1;
    }

    return -1;
  }

  /**
   * 计算辅助驾驶 / 全自动驾驶的控制输出。
   *
   * @param state     当前车辆状态
   * @param track     赛道（提供中心线与航向）
   * @param mode      当前模式，manual 时原样返回玩家输入
   * @param playerInput 玩家输入（手机陀螺仪 / 键盘）
   * @param dt        时间步长（秒）
   * @param obstacles 障碍物列表（用于避障）
   */
  compute(
    state: CarState,
    track: Track,
    mode: DriveMode,
    playerInput: ControlPacket,
    dt: number,
    obstacles: readonly Obstacle[] = [],
  ): ControlPacket {
    if (!isAutonomousMode(mode)) {
      return { ...playerInput };
    }

    const cfg = this.config;
    dt = clamp(dt, 0.0001, 0.05);

    // ===== 1. 感知：前视点 + 赛道横向偏移 =====
    const near = track.nearestPoint(state.x, state.z);
    const aim = this.getAimPoint(track, state);

    // ===== 2. 避障：横向让位 + 限速 =====
    const avoidance = this.planAvoidance(state, obstacles, track.halfWidth);
    this.smoothAvoid += (avoidance.lateralOffset - this.smoothAvoid) * (1 - Math.exp(-dt * 4));

    // ===== 3. 纵向目标速度 =====
    let targetSpeed: number;
    if (mode === 'auto') {
      const cornerLimit = this.getCornerSpeedLimit(track, near.distance, state.speed);
      targetSpeed = Math.min(cornerLimit, cfg.cruiseSpeed, avoidance.speedLimit);
    } else {
      // 辅助驾驶：不主动巡航，只保证「别冲出去」——
      // 玩家踩油门时尽量满足，只有严重偏离赛道或要撞障碍物才介入减速
      const offTrack = near.distToTrack > track.halfWidth * 0.75;
      const headingErr = Math.abs(normalizeAngle(near.heading - state.heading));
      const cornerLimit = this.getCornerSpeedLimit(track, near.distance, state.speed);
      const guard = offTrack || headingErr > 0.6
        ? Math.min(cornerLimit, cfg.assistThrottle * cfg.cruiseSpeed)
        : avoidance.speedLimit;
      targetSpeed = guard;
    }

    // ===== 4. 油门 / 刹车 =====
    let throttle = 0;
    let brake = 0;
    const speedGap = targetSpeed - state.speed;

    if (speedGap < -1.0) {
      // 超速：按差距比例刹车，弯越急刹得越狠
      brake = clamp((-speedGap) * 0.09, 0, cfg.maxAutoBrake);
    } else {
      if (mode === 'auto') {
        // 全自动：比例油门，接近目标速度时收油
        throttle = clamp(speedGap * 0.22 + 0.25, 0.25, 1.0);
        if (speedGap < 0.8) throttle = Math.max(0, speedGap * 0.3);
      } else {
        // 辅助：以玩家的油门为主，系统补足到目标速度
        const playerThrottle = clamp(playerInput.throttle, 0, 1);
        throttle = Math.max(playerThrottle, clamp(speedGap * 0.25, 0, cfg.assistThrottle));
      }
    }

    // 玩家刹车优先级最高（安全冗余）
    if (playerInput.brake > 0) {
      brake = Math.max(brake, clamp(playerInput.brake, 0, 1));
      throttle = Math.min(throttle, 0.2);
    }

    // ===== 5. 转向：航向误差 + 横向误差 + 避让偏移 =====
    // 符号约定统一：以下 laneError / avoidError 均为「正 = 车相对目标偏左」，
    // 与 perceiveTarget().lateralOffset（正 = 目标在车右侧）保持同一套语义。
    //
    // Track.nearestPoint().lateralOffset 的符号与上面相反（正 = 车在中心线左侧），
    // 历史代码直接把两者相加导致修正方向整体反号，这里显式取负号转换。
    const laneOffset = this.getLaneOffset(track);
    // 车相对「右侧目标车道线」的横向误差（正 = 车在目标线左侧 = 需要向右修正）
    const laneError = -near.lateralOffset - laneOffset + this.smoothAvoid;
    const headingError = normalizeAngle(aim.bearing - state.heading);

    // 车道保持容差：只对「赛道本身的横向误差」放宽，避免居中时画龙；
    // 避让产生的偏移必须始终生效，否则系统会无视障碍物直冲上去。
    const onLane = Math.abs(-near.lateralOffset - laneOffset) < cfg.laneTolerance;
    const correction = onLane
      ? this.smoothAvoid * cfg.lateralGain
      : laneError * cfg.lateralGain;

    let steer = headingError * cfg.steerGain - correction;

    // 抑制前轮已经打死时的持续叠加（模拟转向机回正阻尼）
    steer -= clamp(state.steerAngle * cfg.headingDamp, -0.3, 0.3);

    // 车速很低时前视点太近，航向误差会剧烈抖动 → 按速度缩放
    const speedScale = clamp(Math.abs(state.speed) / 6, 0.35, 1);
    steer *= speedScale;

    this.smoothSteer += (steer - this.smoothSteer) * (1 - Math.exp(-dt * 9));
    const outSteer = clamp(this.smoothSteer, -1, 1);

    // ===== 6. 自动换挡 =====
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const rpm = estimateRpm(state.speed, state.currentGear);
    const desired = this.chooseGear(state.speed, state.currentGear, rpm, throttle);
    if (desired > 0) {
      this.shiftGear = desired;
      this.shiftTimer = cfg.shiftCooldown;
    }
    let gear = desired > 0 ? desired : state.currentGear;
    if (gear < 1) gear = 1; // 自动驾驶不使用空挡/倒挡

    return {
      steer: outSteer,
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      gear,
    };
  }
}

/**
 * 角度归一化到 [-PI, PI]
 */
export function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * 由车速与挡位估算转速 [0,1]，与 CarPhysics 内的计算保持一致。
 */
export function estimateRpm(speed: number, gear: number): number {
  const info = getGearRatio(gear);
  if (!info || gear <= 0) return 0;
  const speedAbs = Math.abs(speed);
  if (speedAbs <= 0.5) return 0;
  return clamp(speedAbs / info.maxSpeed, 0, 1);
}
