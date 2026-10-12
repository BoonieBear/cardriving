/**
 * 车辆物理系统（阶段一 + 阶段二漂移）
 *
 * 阶段一：基础行驶物理——加速、减速、空气阻力、滚动阻力、动态转向、惯性；
 * 阶段二：漂移物理——车轮滑移检测、漂移双条件判定（车速 + 侧向滑移）、
 *        漂移时降低侧向抓地力、侧向惯性维持、出弯自动回正、滑移角上限保护。
 *
 * 坐标与符号约定（全工程统一）：
 *  - heading = 0 朝 +Z，heading 增大朝 +X 旋转；
 *  - 前向 = (sin θ, cos θ)，右向 = (cos θ, -sin θ)。
 *
 * 漂移核心模型（速度方向滞后模型）：
 *  - `heading`（车头朝向）按自行车模型旋转：ω = v / L · tan δ；
 *  - `travelHeading`（速度方向）以「抓地力允许的最大角速度」追赶车头；
 *  - 二者之差即滑移角 slip = heading − travelHeading：
 *      · 抓地力充足（v·ω ≤ 抓地上限）时 travelHeading 完全跟上车头 → slip = 0，
 *        行驶表现与阶段一的纯自行车模型完全一致；
 *      · 抓地力不足（v·ω > 抓地上限）时速度方向落后 → slip 累积 → 侧滑漂移。
 *  - 位置沿 travelHeading 前进，因此车身朝向与行进方向可以不一致（画面上的横滑）。
 */
import { clamp, lerp, normalizeAngle } from '../../../shared/utils/math.js';
import type { ControlPacket } from '../../../shared/protocol.js';

export interface CarState {
  x: number;          // 世界坐标 X
  z: number;          // 世界坐标 Z
  y: number;          // 世界坐标 Y（高度，阶段一固定为0）
  heading: number;    // 车头朝向角（弧度）
  travelHeading: number; // 速度方向（弧度）。与 heading 的差值即滑移角
  speed: number;      // 前进速度（m/s，正值前进，负值倒车）。速度矢量大小
  lateralSpeed: number;  // 车身坐标系侧向速度（m/s，正值=车头右侧）
  slipAngle: number;  // 滑移角（弧度，正=车头相对速度方向偏右）
  driftIntensity: number; // 漂移强度 [0,1]（渲染烟雾/调试显示用）
  yawRate: number;    // 当前偏航角速度（rad/s）
  steerAngle: number; // 当前前轮转向角（弧度）
  currentGear: number; // 当前挡位：-1=倒挡, 0=空挡, 1-5=前进挡
  isDrifting: boolean; // 漂移状态
  rpm: number;        // 发动机转速（0-1，用于显示）
}

/** 前轴 / 后轴侧偏角（车轮滑移检测输出） */
export interface WheelSlip {
  /** 前轮侧偏角（弧度，正=车头相对速度方向偏右） */
  front: number;
  /** 后轮侧偏角（弧度） */
  rear: number;
  /** 后轮是否已饱和（失去抓地，漂移的物理成因） */
  rearSaturated: boolean;
}

/**
 * 手动变速箱参数
 */
export interface GearRatio {
  gear: number;       // 挡位编号
  ratio: number;      // 传动比（越大扭矩越大，极速越低）
  maxSpeed: number;   // 该挡最高车速 (m/s)
  minSpeed: number;   // 该挡最低车速（低于此速度会熄火/顿挫）
}

export const GEAR_RATIOS: GearRatio[] = [
  { gear: -1, ratio: 3.4, maxSpeed: 12, minSpeed: -999 }, // 倒挡
  { gear: 1, ratio: 3.5, maxSpeed: 22, minSpeed: 0 },      // 1挡
  { gear: 2, ratio: 2.1, maxSpeed: 38, minSpeed: 5 },      // 2挡
  { gear: 3, ratio: 1.4, maxSpeed: 52, minSpeed: 15 },     // 3挡
  { gear: 4, ratio: 1.0, maxSpeed: 65, minSpeed: 28 },     // 4挡
  { gear: 5, ratio: 0.75, maxSpeed: 80, minSpeed: 42 },    // 5挡
];

export function getGearRatio(gear: number): GearRatio | null {
  return GEAR_RATIOS.find(g => g.gear === gear) ?? null;
}

/**
 * 非对称指数平滑：输入幅值增大时用 attackRate，减小时用 releaseRate。
 *
 * 与固定速率的指数平滑相比，既保留「与帧率无关」的稳定性，
 * 又能在松开方向/油门时更柔和，吸收 30Hz 网络操控包的抖动。
 */
export function smoothInput(
  current: number,
  target: number,
  dt: number,
  attackRate: number,
  releaseRate: number,
): number {
  const shrinking = Math.abs(target) < Math.abs(current);
  const rate = shrinking ? releaseRate : attackRate;
  return lerp(current, target, 1 - Math.exp(-dt * rate));
}

export interface CarConfig {
  // 动力
  maxSpeed: number;        // 最高车速 (m/s) ≈ 200km/h
  reverseMaxSpeed: number; // 倒车最高车速 (m/s)
  acceleration: number;    // 最大加速度 (m/s²)
  brakeForce: number;      // 刹车减速度 (m/s²)

  // 阻力
  airResistanceCoeff: number;  // 空气阻力系数
  rollingResistanceCoeff: number; // 滚动阻力系数

  // 转向
  maxSteerAngle: number;   // 最大转向角（弧度）≈ 30°
  wheelbase: number;        // 轴距 (m)
  steerSpeed: number;       // 转向角速度（弧度/秒）
  highSpeedSteerDamping: number; // 高速转向衰减系数 [0,1]
  lowSpeedSteerGain: number;     // 低速转向增益（低速更灵敏，掉头/泊车用）

  // 漂移（阶段二）
  frontAxleDistance: number;    // 前轴到质心距离 (m)
  rearAxleDistance: number;     // 后轴到质心距离 (m)
  gripNormal: number;           // 正常侧向抓地上限 (m/s²)
  gripDrift: number;            // 漂移时侧向抓地上限 (m/s²)
  gripSpeedFloor: number;       // 抓地力换算用的车速下限 (m/s)，避免低速除零与低速打滑
  driftSpeedThreshold: number;  // 触发漂移的最低车速 (m/s)
  driftSlipThreshold: number;   // 触发漂移的滑移角阈值 (rad)
  driftSteerThreshold: number;  // 触发漂移的最小转向输入（方向盘比例 0~1，接近满舵才算大转向）
  driftExitSpeed: number;       // 退出漂移的车速阈值 (m/s)
  driftExitSlip: number;        // 退出漂移的滑移角阈值 (rad)
  maxSlipAngle: number;         // 滑移角上限（防原地打转）(rad)
  driftYawGain: number;         // 漂移时车头附加偏航增益
  driftGripRecovery: number;    // 滑移越大后轮抓地回升越多（形成自然的漂移平衡角）
  driftSpeedLoss: number;       // 侧滑损速系数 (1/s)
  driftIntensityRate: number;   // 漂移强度平滑速率 (1/s)

  // 输入平滑（阶段二：降低网络操控包的延迟抖动）
  steerAttackRate: number;      // 转向输入加大时的平滑速率 (1/s)
  steerReleaseRate: number;     // 转向输入回中时的平滑速率 (1/s)
  pedalAttackRate: number;      // 油门/刹车踩下时的平滑速率 (1/s)
  pedalReleaseRate: number;     // 油门/刹车松开时的平滑速率 (1/s)

  // 其他
  mass: number;             // 车辆质量 (kg)
}

export const DEFAULT_CAR_CONFIG: CarConfig = {
  maxSpeed: 55.5,            // ~200 km/h
  reverseMaxSpeed: 13.9,     // ~50 km/h
  acceleration: 8.0,          // 0-100km/h ≈ 3.5s
  brakeForce: 15.0,

  airResistanceCoeff: 0.0009,
  rollingResistanceCoeff: 0.02,

  maxSteerAngle: 0.52,        // 30°（满舵，配合漂移大转向门槛）
  wheelbase: 2.7,
  steerSpeed: 2.8,
  highSpeedSteerDamping: 0.7, // 高速时转向灵敏度降到30%
  lowSpeedSteerGain: 1.25,    // 低速（<15m/s）最多放大 25%，方便掉头

  // ===== 漂移（阶段二）=====
  frontAxleDistance: 1.2,
  rearAxleDistance: 1.5,      // 前+后 = wheelbase
  gripNormal: 24.0,           // ≈2.45g，正常/低速满舵都抓得住，只有高速大转向才打滑
  gripDrift: 7.5,             // 漂移时后轮抓地力大幅下降
  gripSpeedFloor: 8,          // 低速时按 8 m/s 换算，低速转向永远是「抓得住」的
  driftSpeedThreshold: 15,    // ≈54 km/h 以上才可能起漂（原来 12，降误触发）
  driftSlipThreshold: 0.16,   // ≈9.2°，需要更明显的侧滑才算漂移（原来 0.12）
  driftSteerThreshold: 0.85,  // 方向盘打到约85%以上（接近打满30°）才允许起漂
  driftExitSpeed: 9,          // ≈32 km/h 以下自动收漂（跟着进入阈值提高）
  driftExitSlip: 0.09,        // ≈5.2°，滞后退出避免状态抖动
  maxSlipAngle: 0.7,          // ≈40°，上限保护防止原地打转
  driftYawGain: 0.3,          // 漂移中车头额外向弯内甩
  driftGripRecovery: 1.2,     // 滑移角越大，后轮越能重新咬住地面 → 存在稳定的漂移平衡角
  driftSpeedLoss: 0.12,       // 侧滑刮擦损耗前进速度
  driftIntensityRate: 6,      // 漂移强度平滑

  // ===== 输入平滑（阶段二）=====
  // 非对称：踩下/打方向响应快（低延迟），松开/回中衰减慢（顺滑），
  // 从而在 30Hz 网络包抖动下既不顿挫、也不拖沓。
  steerAttackRate: 12,
  steerReleaseRate: 7,
  pedalAttackRate: 18,
  pedalReleaseRate: 10,

  mass: 1400,
};

export class CarPhysics {
  public state: CarState;
  public config: CarConfig;

  // 输入平滑
  private smoothSteer: number = 0;
  private smoothThrottle: number = 0;
  private smoothBrake: number = 0;

  // 地形高度回调（用于坡度重力计算）
  private terrainHeightFn: ((x: number, z: number) => number) | null = null;

  // 障碍物列表（用于碰撞检测）
  private obstacles: { x: number; z: number; radius: number }[] = [];

  // 碰撞冷却（防止连续碰撞抖动）
  private collisionCooldown: number = 0;

  // 外部速度上限（辅助驾驶/自动驾驶的弯道限速、避障限速用）
  // null 表示不限速，仅受挡位与 config.maxSpeed 约束
  private externalSpeedLimit: number | null = null;

  constructor(config?: Partial<CarConfig>) {
    this.config = { ...DEFAULT_CAR_CONFIG, ...config };
    this.state = {
      x: 0,
      z: 0,
      y: 0,
      heading: 0,
      travelHeading: 0,
      speed: 0,
      lateralSpeed: 0,
      slipAngle: 0,
      driftIntensity: 0,
      yawRate: 0,
      steerAngle: 0,
      currentGear: 1,
      isDrifting: false,
      rpm: 0,
    };
  }

  /**
   * 设置地形高度函数，用于计算坡度重力（爬坡减速、下坡加速）
   */
  setTerrainHeight(fn: (x: number, z: number) => number): void {
    this.terrainHeightFn = fn;
  }

  /**
   * 设置障碍物列表（树木、岩石等），用于碰撞检测
   */
  setObstacles(obstacles: { x: number; z: number; radius: number }[]): void {
    this.obstacles = obstacles;
  }

  /**
   * 获取障碍物列表（自动驾驶避障需要读取同一份数据）
   */
  getObstacles(): { x: number; z: number; radius: number }[] {
    return this.obstacles;
  }

  /**
   * 设置外部速度上限（m/s）。
   * 辅助驾驶/自动驾驶据此执行弯道限速与避障限速，超速时会被约束回来。
   * 传 null 取消限速。
   */
  setSpeedLimit(limit: number | null): void {
    this.externalSpeedLimit =
      limit === null || !Number.isFinite(limit) ? null : Math.max(0, limit);
  }

  /**
   * 获取当前生效的外部速度上限（无限速时为 null）
   */
  getSpeedLimit(): number | null {
    return this.externalSpeedLimit;
  }

  /**
   * 更新车辆物理
   * @param input 操控输入
   * @param dt 时间步长（秒）
   */
  update(input: ControlPacket, dt: number): void {
    const cfg = this.config;
    const s = this.state;

    // 限制 dt 防止跳帧
    dt = Math.min(dt, 0.05);

    // ========== 输入平滑 ==========
    // 非对称平滑（阶段二）：输入「变大」时用较快的速率跟上（降低操控延迟），
    // 输入「回中/松开」时用较慢的速率衰减（吸收网络包抖动，不产生顿挫）。
    // 判据用「目标幅值是否小于当前幅值」，因此满舵直接反打仍按快速率处理。
    this.smoothSteer = smoothInput(
      this.smoothSteer, input.steer, dt, cfg.steerAttackRate, cfg.steerReleaseRate,
    );
    this.smoothThrottle = smoothInput(
      this.smoothThrottle, input.throttle, dt, cfg.pedalAttackRate, cfg.pedalReleaseRate,
    );
    this.smoothBrake = smoothInput(
      this.smoothBrake, input.brake, dt, cfg.pedalAttackRate, cfg.pedalReleaseRate,
    );

    // ========== 转向计算 ==========
    // 高低速手感区分（阶段二）：
    //  - 高速：速度越高最大转向角越小，防止高速轻轻一打就失控；
    //  - 低速：给一个轻微增益，让掉头 / 绕桩不打折扣。
    const speedFactor = clamp(Math.abs(s.speed) / cfg.maxSpeed, 0, 1);
    const speedDamping = 1 - cfg.highSpeedSteerDamping * speedFactor;
    // 低速增益随车速线性退出：0 m/s 时满增益，15 m/s 以上完全退出
    const lowSpeedFactor = clamp(1 - Math.abs(s.speed) / 15, 0, 1);
    const steerGain = speedDamping * (1 + (cfg.lowSpeedSteerGain - 1) * lowSpeedFactor);
    const effectiveMaxSteer = cfg.maxSteerAngle * steerGain;

    // 目标转向角
    const targetSteer = this.smoothSteer * effectiveMaxSteer;
    // 转向角速度限制（模拟转向机速度）
    const maxSteerDelta = cfg.steerSpeed * dt;
    s.steerAngle = clamp(
      targetSteer,
      s.steerAngle - maxSteerDelta,
      s.steerAngle + maxSteerDelta
    );

    // ========== 纵向动力学（手动变速箱）==========
    let acceleration = 0;
    const gear = input.gear ?? s.currentGear;
    s.currentGear = gear;
    const gearInfo = getGearRatio(gear);

    if (gear === 0) {
      // 空挡：无动力，无引擎制动，只有自然阻力
      // 油门无效
    } else if (gearInfo) {
      const isReverse = gear < 0;
      const speedAbs = Math.abs(s.speed);

      // 计算 RPM（0-1，用于显示和扭矩曲线）
      if (speedAbs > 0.5) {
        s.rpm = clamp(speedAbs / gearInfo.maxSpeed, 0, 1);
      } else {
        s.rpm = this.smoothThrottle * 0.3; // 怠速时油门拉高转速
      }

      // 扭矩曲线：低转速高扭矩，高转速衰减
      const torqueCurve = 1.0 - Math.pow(s.rpm - 0.6, 2) * 0.8;
      const effectiveTorque = clamp(torqueCurve, 0.3, 1.2);

      if (this.smoothThrottle > 0) {
        if (isReverse) {
          // 倒挡：油门向后加速
          if (s.speed > -gearInfo.maxSpeed) {
            acceleration -= this.smoothThrottle * cfg.acceleration * gearInfo.ratio * effectiveTorque * 0.6;
          }
        } else {
          // 前进挡：油门向前加速
          if (s.speed < gearInfo.maxSpeed) {
            acceleration += this.smoothThrottle * cfg.acceleration * gearInfo.ratio * effectiveTorque;
          }
        }
      }

      // 引擎制动（松油门时，档位越低制动越强）
      if (this.smoothThrottle < 0.05 && speedAbs > 1) {
        const engineBraking = gearInfo.ratio * 0.4;
        if (s.speed > 0) {
          acceleration -= engineBraking;
        } else {
          acceleration += engineBraking;
        }
      }

      // 速度限制（该挡最高车速，并叠加外部限速）
      // 外部限速只约束「前进方向」；倒挡仍按自身极速约束。
      const forwardCap = this.externalSpeedLimit === null
        ? gearInfo.maxSpeed
        : Math.min(gearInfo.maxSpeed, this.externalSpeedLimit);
      if (!isReverse && s.speed > forwardCap) {
        s.speed = forwardCap;
      }
      if (isReverse && s.speed < -gearInfo.maxSpeed) {
        s.speed = -gearInfo.maxSpeed;
      }
    }

    // 刹车（所有档位都有效）
    if (this.smoothBrake > 0) {
      if (s.speed > 0.1) {
        acceleration -= this.smoothBrake * cfg.brakeForce;
      } else if (s.speed < -0.1) {
        acceleration += this.smoothBrake * cfg.brakeForce;
      } else {
        s.speed = 0;
      }
    }

    // 空气阻力 F = 0.5 * ρ * Cd * A * v² ≈ k * v²
    const airDrag = -cfg.airResistanceCoeff * s.speed * Math.abs(s.speed);
    // 滚动阻力 F = μ * m * g，简化为 k * v
    const rollingDrag = -cfg.rollingResistanceCoeff * s.speed;

    acceleration += airDrag + rollingDrag;

    // 坡度重力：爬坡减速、下坡加速
    // 采样前方1米处的地形高度，计算坡度角
    if (this.terrainHeightFn && Math.abs(s.speed) > 0.1) {
      const hHere = this.terrainHeightFn(s.x, s.z);
      const lookAhead = 1.0; // 米
      const hAhead = this.terrainHeightFn(
        s.x + Math.sin(s.heading) * lookAhead,
        s.z + Math.cos(s.heading) * lookAhead,
      );
      const slopeAngle = Math.atan2(hAhead - hHere, lookAhead);
      // 重力沿坡面分量：g * sin(θ)，上坡为负（减速），下坡为正（加速）
      const gravityAccel = -9.81 * Math.sin(slopeAngle);
      acceleration += gravityAccel;
    }

    // 漂移侧滑损速（阶段二）：轮胎横向刮擦会持续吃掉前进速度，
    // 越大的侧向速度损耗越快——这是漂移过弯比走线慢的原因。
    if (s.isDrifting && Math.abs(s.lateralSpeed) > 0.5) {
      acceleration -= Math.sign(s.speed) * cfg.driftSpeedLoss * Math.abs(s.lateralSpeed);
    }

    // 更新速度
    s.speed += acceleration * dt;

    // 全局速度上限（安全限制，实际由档位限制）
    // 外部限速（辅助驾驶/自动驾驶）也在此兜底。
    // 注意：挡位极速检查发生在积分「之前」，单帧加速度会让车速略微冲过上限，
    // 因此这里必须再夹紧一次，否则弯道限速会持续小幅突破并来回抖动。
    const gearCap = gearInfo ? gearInfo.maxSpeed : cfg.maxSpeed;
    const forwardCap = this.externalSpeedLimit === null
      ? cfg.maxSpeed
      : Math.min(cfg.maxSpeed, this.externalSpeedLimit);
    if (s.speed > forwardCap) s.speed = forwardCap;
    if (s.speed < -cfg.reverseMaxSpeed) s.speed = -cfg.reverseMaxSpeed;
    // 挡位极速兜底（前进与倒挡都按各自挡位极速夹紧）
    if (s.speed > gearCap) s.speed = gearCap;
    if (s.speed < -gearCap) s.speed = -gearCap;

    // 极小速度自动归零（防止蠕行）
    if (Math.abs(s.speed) < 0.05 && this.smoothThrottle < 0.01) {
      s.speed = 0;
    }

    // ========== 横向动力学 / 漂移（阶段二）==========
    const speedAbs = Math.abs(s.speed);

    // --- 车轮滑移检测：滑移角 = 车头方向 − 速度方向 ---
    let slip = normalizeAngle(s.heading - s.travelHeading);

    // --- 漂移判定：车速阈值 + 侧向滑移阈值（双条件），带退出滞后 ---
    // 进入条件（三个都要满足）：车速够快 + 滑移角够大 + 转向接近打满（大转向才漂）；
    // 退出条件（满足其一）：车速掉下来 或 滑移角收回来。
    // 倒挡与慢速不参与漂移判定。
    if (!s.isDrifting) {
      if (
        s.speed >= cfg.driftSpeedThreshold &&
        speedAbs >= cfg.driftSpeedThreshold &&
        Math.abs(this.smoothSteer) >= cfg.driftSteerThreshold &&
        Math.abs(slip) >= cfg.driftSlipThreshold
      ) {
        s.isDrifting = true;
      }
    } else if (speedAbs < cfg.driftExitSpeed || Math.abs(slip) < cfg.driftExitSlip) {
      s.isDrifting = false;
    }

    // --- 抓地上限：漂移时后轮失去抓地，侧向抓地力大幅下降 ---
    // 滑移角越大，轮胎横向刮擦越剧烈、后轮会重新「咬」回一部分抓地力，
    // 因此在某个滑移角上前后达成平衡 —— 这就是可以稳定维持的漂移角，
    // 而不是一味甩到上限。抓地力最多恢复到正常水平。
    const absSlip = Math.abs(slip);
    const grip = s.isDrifting
      ? Math.min(
          cfg.gripNormal,
          cfg.gripDrift * (1 + cfg.driftGripRecovery * Math.max(0, absSlip - cfg.driftExitSlip)),
        )
      : cfg.gripNormal;
    // 抓地力换算成「速度方向每秒最多能转多少弧度」：a = v·ω ≤ grip → ω_max = grip / v。
    // 低速下限用于避免除零，同时保证低速转向永远抓得住（不会莫名侧滑）。
    const gripRefSpeed = Math.max(speedAbs, cfg.gripSpeedFloor);
    const maxAlignRate = grip / gripRefSpeed;

    // --- 车头偏航角速度：自行车模型 ω = v / L · tan δ ---
    let yawRate = speedAbs > 0.1
      ? (s.speed / cfg.wheelbase) * Math.tan(s.steerAngle)
      : 0;
    // 漂移中后轮已失去抓地，车头会额外向弯内甩，滑移角更快建立
    yawRate *= 1 + cfg.driftYawGain * s.driftIntensity;

    // --- 滑移角上限保护（防原地打转）---
    // 滑移角已经顶到上限、且方向盘还在往同一侧加大滑移时，
    // 车头只能跟着速度方向一起转，不再继续甩出去。
    if (
      Math.abs(slip) >= cfg.maxSlipAngle &&
      slip !== 0 && yawRate !== 0 && Math.sign(yawRate) === Math.sign(slip)
    ) {
      yawRate = Math.sign(yawRate) * Math.min(Math.abs(yawRate), maxAlignRate);
    }
    s.yawRate = yawRate;

    // 车头旋转
    if (speedAbs > 0.1) {
      s.heading = normalizeAngle(s.heading + yawRate * dt);
    }

    // --- 速度方向追赶车头：受抓地力限制，这就是「侧向惯性」的来源 ---
    // 抓地力足够时 travelHeading 完全跟上车头（slip → 0，等同阶段一自行车模型）；
    // 抓地力不足时速度方向落后，滑移角累积 → 车辆横滑。
    slip = normalizeAngle(s.heading - s.travelHeading);
    const alignRate = clamp(slip / Math.max(dt, 1e-4), -maxAlignRate, maxAlignRate);
    s.travelHeading = normalizeAngle(s.travelHeading + alignRate * dt);

    // 上限兜底（数值安全）
    slip = normalizeAngle(s.heading - s.travelHeading);
    if (Math.abs(slip) > cfg.maxSlipAngle) {
      slip = Math.sign(slip) * cfg.maxSlipAngle;
      s.travelHeading = normalizeAngle(s.heading - slip);
    }

    // --- 出弯自动回正 ---
    // 抓地恢复后 alignRate = slip/dt 会把速度方向直接拉回车头，滑移角迅速收敛；
    // 方向盘回正 / 反打时车头也反向旋转，两者叠加实现「松手自动回正」。
    s.slipAngle = slip;
    // 车身坐标系侧向速度：V = speed · forward(travelHeading)，
    // 投影到车身右向 perpRight(heading) 得 vLat = −speed · sin(slip)。
    s.lateralSpeed = -s.speed * Math.sin(slip);

    // 漂移强度（0-1，渲染烟雾 / 调试面板 / 手机提示用）
    const targetIntensity = s.isDrifting
      ? clamp(
          (Math.abs(slip) - cfg.driftExitSlip) / Math.max(cfg.maxSlipAngle - cfg.driftExitSlip, 1e-4),
          0,
          1,
        )
      : 0;
    s.driftIntensity = lerp(s.driftIntensity, targetIntensity, 1 - Math.exp(-dt * cfg.driftIntensityRate));
    if (!s.isDrifting && s.driftIntensity < 0.01) s.driftIntensity = 0;

    // --- 位置更新：沿「速度方向」前进（滑移时车身与行进方向不一致）---
    s.x += Math.sin(s.travelHeading) * s.speed * dt;
    s.z += Math.cos(s.travelHeading) * s.speed * dt;

    // ========== 碰撞检测 ==========
    if (this.collisionCooldown > 0) {
      this.collisionCooldown -= dt;
    }
    if (this.collisionCooldown <= 0 && this.obstacles.length > 0) {
      const carRadius = 1.2; // 车辆碰撞半径
      for (const obs of this.obstacles) {
        const dx = s.x - obs.x;
        const dz = s.z - obs.z;
        const dist = Math.hypot(dx, dz);
        const minDist = carRadius + obs.radius;
        if (dist < minDist && dist > 0.01) {
          // 碰撞：反弹 + 减速
          const nx = dx / dist;
          const nz = dz / dist;
          // 将车推出障碍物
          const push = minDist - dist;
          s.x += nx * push;
          s.z += nz * push;
          // 速度衰减（反弹）：用速度方向判断是否朝障碍物运动
          const speedAlongNormal = s.speed * (Math.sin(s.travelHeading) * nx + Math.cos(s.travelHeading) * nz);
          if (speedAlongNormal > 0) {
            // 只有朝向障碍物运动时才反弹
            s.speed *= -0.3; // 反弹并大幅减速
          } else {
            s.speed *= 0.5; // 侧面摩擦减速
          }
          this.collisionCooldown = 0.3; // 碰撞冷却
          break;
        }
      }
    }
  }

  /**
   * 输入清零，车辆缓降停止（轻微刹车）。
   *
   * 注意：控制器断开现在由「全自动驾驶接管」处理（见 GameEngine.enterDisconnectTakeover），
   * 不再调用本方法。它保留为通用的「安全滑停」工具，也用于测试与手动救援场景。
   */
  coastToStop(dt: number): void {
    const zeroInput: ControlPacket = {
      steer: 0,
      throttle: 0,
      brake: 0.15, // 轻微刹车缓降
      gear: this.state.currentGear,
    };
    this.update(zeroInput, dt);
  }

  /**
   * 重置车辆状态
   */
  reset(x?: number, z?: number, heading?: number): void {
    this.state.x = x ?? 0;
    this.state.z = z ?? 0;
    this.state.y = 0;
    this.state.heading = heading ?? 0;
    // 速度方向同步归位，否则复位后会残留一个巨大的滑移角
    this.state.travelHeading = heading ?? 0;
    this.state.speed = 0;
    this.state.lateralSpeed = 0;
    this.state.slipAngle = 0;
    this.state.driftIntensity = 0;
    this.state.yawRate = 0;
    this.state.steerAngle = 0;
    this.state.isDrifting = false;
    this.smoothSteer = 0;
    this.smoothThrottle = 0;
    this.smoothBrake = 0;
  }

  /**
   * 获取车速（km/h）
   *
   * 速度矢量大小恒等于 |speed|（速度方向只改变方向不改变大小），
   * 因此漂移中显示的仍是真实地面车速。
   */
  getSpeedKmh(): number {
    return Math.abs(this.state.speed) * 3.6;
  }

  /**
   * 当前滑移角（弧度，正=车头相对速度方向偏右）
   */
  getSlipAngle(): number {
    return this.state.slipAngle;
  }

  /**
   * 当前平滑后的操控输入（调试面板 / 测试用）。
   * 与原始网络包对照可以直观看到平滑与抖动抑制的效果。
   */
  getSmoothedInput(): { steer: number; throttle: number; brake: number } {
    return {
      steer: this.smoothSteer,
      throttle: this.smoothThrottle,
      brake: this.smoothBrake,
    };
  }

  /**
   * 当前漂移强度 [0,1]
   */
  getDriftIntensity(): number {
    return this.state.driftIntensity;
  }

  /**
   * 车轮滑移检测：由自行车模型的几何关系估算前/后轴侧偏角。
   *
   *  - 前轮侧偏角 α_f = atan2(v_lat + l_f·ω, |v|) − δ·sign(v)
   *  - 后轮侧偏角 α_r = atan2(v_lat − l_r·ω, |v|)
   *
   * 后轮侧偏角超过抓地饱和角（后轴抓地上限 / 车速）时判定为「已饱和」，
   * 这正是漂移的物理成因，调试面板与单元测试都依赖它。
   */
  getWheelSlip(): WheelSlip {
    const s = this.state;
    const cfg = this.config;
    const speedAbs = Math.abs(s.speed);
    const vLat = s.lateralSpeed;
    const omega = s.yawRate;

    if (speedAbs < 0.5) {
      return { front: 0, rear: 0, rearSaturated: false };
    }

    const dir = Math.sign(s.speed) || 1;
    const front = Math.atan2(vLat + cfg.frontAxleDistance * omega, speedAbs) - s.steerAngle * dir;
    const rear = Math.atan2(vLat - cfg.rearAxleDistance * omega, speedAbs);

    // 后轴饱和角：抓地上限换算成侧偏角（与 update() 使用同一套抓地力模型）
    const grip = s.isDrifting
      ? Math.min(
          cfg.gripNormal,
          cfg.gripDrift * (1 + cfg.driftGripRecovery * Math.max(0, Math.abs(s.slipAngle) - cfg.driftExitSlip)),
        )
      : cfg.gripNormal;
    const saturateAngle = grip / Math.max(speedAbs, cfg.gripSpeedFloor);
    return {
      front,
      rear,
      rearSaturated: Math.abs(rear) >= saturateAngle * 0.9,
    };
  }
}
