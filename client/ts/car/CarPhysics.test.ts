/**
 * @vitest-environment jsdom
 *
 * CarPhysics 车辆物理单元测试
 * 覆盖：
 *  - 阶段一：外部限速（setSpeedLimit）、挡位极速、倒挡、断线缓降、碰撞；
 *  - 阶段二：车轮滑移检测、漂移双条件判定、侧向打滑/惯性维持、出弯回正、
 *           滑移角上限保护、高低速转向手感区分。
 */
import { describe, it, expect } from 'vitest';
import { CarPhysics, DEFAULT_CAR_CONFIG, getGearRatio, GEAR_RATIOS, smoothInput } from './CarPhysics';
import type { ControlPacket } from '../../../shared/protocol';

const NEUTRAL: ControlPacket = { steer: 0, throttle: 0, brake: 0, gear: 0 };

function fullThrottle(gear: number): ControlPacket {
  return { steer: 0, throttle: 1, brake: 0, gear };
}

/** 以固定步长推进若干秒 */
function run(car: CarPhysics, input: ControlPacket, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) car.update(input, dt);
}

/** 加速到高速（4 挡全油门） */
function accelerate(car: CarPhysics, seconds = 4, gear = 4): void {
  run(car, fullThrottle(gear), seconds);
}

/**
 * 以恒定车速推进（每帧把车速钉住）。
 * 用于隔离「车速」这一自变量，避免油门/阻力把车带出被测速度区间。
 */
function runAtSpeed(car: CarPhysics, speed: number, input: ControlPacket, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    car.state.speed = speed;
    car.update(input, dt);
  }
}

describe('CarPhysics — 挡位极速上限', () => {
  it('1 挡全油门不会超过 1 挡极速', () => {
    const car = new CarPhysics();
    run(car, fullThrottle(1), 12);
    const cap = getGearRatio(1)!.maxSpeed;
    expect(car.state.speed).toBeLessThanOrEqual(cap + 1e-6);
    expect(car.state.speed).toBeGreaterThan(0);
  });

  it('每个前进挡都受各自极速约束', () => {
    for (const g of GEAR_RATIOS.filter(x => x.gear > 0)) {
      const car = new CarPhysics();
      run(car, fullThrottle(g.gear), 20);
      expect(car.state.speed, `${g.gear} 挡`).toBeLessThanOrEqual(g.maxSpeed + 1e-6);
    }
  });

  it('空挡无动力，速度不会自行增加', () => {
    const car = new CarPhysics();
    car.state.speed = 10;
    run(car, NEUTRAL, 3);
    expect(car.state.speed).toBeLessThan(10);
  });
});

describe('CarPhysics — 外部限速（辅助驾驶/自动驾驶）', () => {
  it('未设置限速时 getSpeedLimit() 返回 null', () => {
    const car = new CarPhysics();
    expect(car.getSpeedLimit()).toBeNull();
  });

  it('设置限速后全油门被限制在限速值以内', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(8);
    run(car, fullThrottle(3), 15);
    expect(car.state.speed).toBeLessThanOrEqual(8 + 1e-6);
    expect(car.state.speed).toBeGreaterThan(7);
  });

  it('限速低于当前车速时，车速被立即约束回限速（弯道减速兜底）', () => {
    const car = new CarPhysics();
    car.state.speed = 40;
    car.setSpeedLimit(20);
    car.update(fullThrottle(4), 1 / 60);
    expect(car.state.speed).toBeLessThanOrEqual(20 + 1e-6);
  });

  it('限速只在前进方向生效，倒挡仍走自身极速', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(5);
    run(car, { steer: 0, throttle: 1, brake: 0, gear: -1 }, 8);
    const reverseCap = Math.abs(getGearRatio(-1)!.maxSpeed);
    expect(car.state.speed).toBeLessThan(0); // 确实在倒车
    expect(car.state.speed).toBeGreaterThanOrEqual(-reverseCap - 1e-6);
  });

  it('setSpeedLimit(null) 取消限速后可以重新加速', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(6);
    run(car, fullThrottle(3), 6);
    expect(car.state.speed).toBeLessThanOrEqual(6 + 1e-6);

    car.setSpeedLimit(null);
    run(car, fullThrottle(3), 10);
    expect(car.state.speed).toBeGreaterThan(6);
  });

  it('非法限速值被忽略（NaN / Infinity 视为不限速）', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(NaN);
    expect(car.getSpeedLimit()).toBeNull();
    car.setSpeedLimit(Infinity);
    expect(car.getSpeedLimit()).toBeNull();
  });

  it('负限速被夹到 0，不会产生反向加速', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(-10);
    expect(car.getSpeedLimit()).toBe(0);
    run(car, fullThrottle(3), 3);
    expect(car.state.speed).toBeLessThanOrEqual(0 + 1e-6);
  });

  it('限速不会突破变速箱自身的挡位极速', () => {
    const car = new CarPhysics();
    car.setSpeedLimit(1000); // 远超车辆极速
    run(car, fullThrottle(2), 20);
    expect(car.state.speed).toBeLessThanOrEqual(getGearRatio(2)!.maxSpeed + 1e-6);
  });
});

describe('CarPhysics — 障碍物接口', () => {
  it('setObstacles / getObstacles 读写同一份数据（自动驾驶避障需要）', () => {
    const car = new CarPhysics();
    const obs = [{ x: 1, z: 2, radius: 3 }];
    car.setObstacles(obs);
    expect(car.getObstacles()).toBe(obs);
    expect(car.getObstacles()[0].radius).toBe(3);
  });

  it('默认无障碍物', () => {
    expect(new CarPhysics().getObstacles()).toEqual([]);
  });

  it('撞上障碍物会被推开并减速', () => {
    const car = new CarPhysics();
    car.setObstacles([{ x: 0, z: 5, radius: 1.5 }]);
    car.state.x = 0;
    car.state.z = 0;
    car.state.heading = 0;
    car.state.speed = 20;
    for (let i = 0; i < 60; i++) car.update({ steer: 0, throttle: 1, brake: 0, gear: 2 }, 1 / 60);
    // 位置被推出障碍物范围之外
    const dist = Math.hypot(car.state.x - 0, car.state.z - 5);
    expect(dist).toBeGreaterThanOrEqual(1.2 + 1.5 - 0.3);
  });
});

describe('CarPhysics — 断线保护与重置', () => {
  it('coastToStop 让车辆逐渐减速', () => {
    const car = new CarPhysics();
    car.state.speed = 30;
    run(car, fullThrottle(4), 1);
    const before = car.state.speed;
    for (let i = 0; i < 300; i++) car.coastToStop(1 / 60);
    expect(car.state.speed).toBeLessThan(before);
  });

  it('reset 清空速度与转向', () => {
    const car = new CarPhysics();
    run(car, { steer: 1, throttle: 1, brake: 0, gear: 2 }, 5);
    car.reset(3, 4, 0.5);
    expect(car.state.x).toBe(3);
    expect(car.state.z).toBe(4);
    expect(car.state.heading).toBe(0.5);
    expect(car.state.speed).toBe(0);
    expect(car.state.steerAngle).toBe(0);
  });

  it('getSpeedKmh 换算正确', () => {
    const car = new CarPhysics();
    car.state.speed = 10; // 10 m/s = 36 km/h
    expect(car.getSpeedKmh()).toBeCloseTo(36, 6);
    car.state.speed = -10;
    expect(car.getSpeedKmh()).toBeCloseTo(36, 6);
  });

  it('reset 清空漂移相关状态', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 1, brake: 0, gear: 3 }, 1);
    expect(car.state.isDrifting).toBe(true);

    car.reset(1, 2, 0.25);
    expect(car.state.travelHeading).toBe(0.25);
    expect(car.state.lateralSpeed).toBe(0);
    expect(car.state.slipAngle).toBe(0);
    expect(car.state.driftIntensity).toBe(0);
    expect(car.state.yawRate).toBe(0);
    expect(car.state.isDrifting).toBe(false);
  });
});

// ============================================================
// 阶段二：漂移物理
// ============================================================

describe('CarPhysics — 车轮滑移检测', () => {
  it('直线行驶时前后轮侧偏角均为 0', () => {
    const car = new CarPhysics();
    run(car, fullThrottle(3), 4);
    const slip = car.getWheelSlip();
    expect(slip.front).toBeCloseTo(0, 6);
    expect(slip.rear).toBeCloseTo(0, 6);
    expect(slip.rearSaturated).toBe(false);
  });

  it('静止时侧偏角为 0（边界）', () => {
    const car = new CarPhysics();
    expect(car.getWheelSlip()).toEqual({ front: 0, rear: 0, rearSaturated: false });
  });

  it('后轮侧偏角符合自行车模型公式 α_r = atan2(v_lat − l_r·ω, |v|)', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 0.7);

    const s = car.state;
    const expectedRear = Math.atan2(
      s.lateralSpeed - DEFAULT_CAR_CONFIG.rearAxleDistance * s.yawRate,
      Math.abs(s.speed),
    );
    const expectedFront =
      Math.atan2(
        s.lateralSpeed + DEFAULT_CAR_CONFIG.frontAxleDistance * s.yawRate,
        Math.abs(s.speed),
      ) - s.steerAngle * Math.sign(s.speed);

    const slip = car.getWheelSlip();
    expect(slip.rear).toBeCloseTo(expectedRear, 9);
    expect(slip.front).toBeCloseTo(expectedFront, 9);
  });

  it('漂移时后轮判定为已饱和（失去抓地）', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1);
    expect(car.state.isDrifting).toBe(true);
    const slip = car.getWheelSlip();
    expect(slip.rearSaturated).toBe(true);
    expect(Math.abs(slip.rear)).toBeGreaterThan(Math.abs(car.state.slipAngle) * 0.5);
  });
});

describe('CarPhysics — 漂移判定（车速 + 侧向滑移双条件）', () => {
  it('高速直线不会触发漂移，滑移角恒为 0', () => {
    const car = new CarPhysics();
    run(car, fullThrottle(5), 6);
    expect(car.state.speed).toBeGreaterThan(DEFAULT_CAR_CONFIG.driftSpeedThreshold);
    expect(car.state.isDrifting).toBe(false);
    expect(car.state.slipAngle).toBeCloseTo(0, 9);
    expect(car.state.travelHeading).toBeCloseTo(car.state.heading, 9);
  });

  it('高速急转稳定触发漂移', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1);
    expect(car.state.isDrifting).toBe(true);
    expect(Math.abs(car.state.slipAngle)).toBeGreaterThanOrEqual(
      DEFAULT_CAR_CONFIG.driftSlipThreshold,
    );
    expect(car.state.driftIntensity).toBeGreaterThan(0.5);
  });

  it('低速满舵不触发漂移（车速边界）', () => {
    const low = new CarPhysics();
    runAtSpeed(low, 8, { steer: 1, throttle: 0.5, brake: 0, gear: 1 }, 3);
    expect(low.state.speed).toBeLessThan(DEFAULT_CAR_CONFIG.driftSpeedThreshold);
    expect(low.state.isDrifting).toBe(false);
    expect(Math.abs(low.state.slipAngle)).toBeLessThan(0.05);

    // 对照：同样满舵，只要车速越过高阈值就会起漂
    const high = new CarPhysics();
    runAtSpeed(high, 25, { steer: 1, throttle: 0.5, brake: 0, gear: 3 }, 1);
    expect(high.state.isDrifting).toBe(true);
  });

  it('倒挡即使车速够快也不触发漂移', () => {
    const car = new CarPhysics();
    run(car, { steer: 0, throttle: 1, brake: 0, gear: -1 }, 6); // 倒车到极速
    expect(car.state.speed).toBeLessThan(0);
    expect(Math.abs(car.state.speed)).toBeGreaterThan(DEFAULT_CAR_CONFIG.driftExitSpeed);
    run(car, { steer: 1, throttle: 1, brake: 0, gear: -1 }, 2);
    expect(car.state.isDrifting).toBe(false);
  });

  it('退出滞后：漂移中滑移角回收后才退出，不会逐帧抖动', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    const driftInput: ControlPacket = { steer: 1, throttle: 0.8, brake: 0, gear: 3 };

    run(car, driftInput, 0.6);
    expect(car.state.isDrifting).toBe(true);

    // 方向回正后滑移角缓慢收敛，期间必须保持漂移状态而不是瞬间闪断
    let sawDriftWhileSlipAboveExit = false;
    for (let i = 0; i < 120; i++) {
      car.update({ steer: 0, throttle: 0.4, brake: 0, gear: 3 }, 1 / 60);
      if (
        car.state.isDrifting &&
        Math.abs(car.state.slipAngle) > DEFAULT_CAR_CONFIG.driftExitSlip
      ) {
        sawDriftWhileSlipAboveExit = true;
      }
    }
    expect(sawDriftWhileSlipAboveExit).toBe(true);
  });

  it('刹车到低速后自动退出漂移', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1);
    expect(car.state.isDrifting).toBe(true);
    run(car, { steer: 0, throttle: 0, brake: 1, gear: 3 }, 3);
    expect(Math.abs(car.state.speed)).toBeLessThan(DEFAULT_CAR_CONFIG.driftExitSpeed);
    expect(car.state.isDrifting).toBe(false);
  });
});

describe('CarPhysics — 侧向打滑 / 惯性维持 / 出弯回正', () => {
  it('漂移时存在明显侧向速度，车身与行进方向不一致', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1);

    const s = car.state;
    expect(Math.abs(s.lateralSpeed)).toBeGreaterThan(3);
    expect(Math.abs(s.slipAngle)).toBeGreaterThan(DEFAULT_CAR_CONFIG.driftSlipThreshold);
    // 侧向速度与滑移角的关系：v_lat = −v·sin(slip)
    expect(s.lateralSpeed).toBeCloseTo(-s.speed * Math.sin(s.slipAngle), 6);
    // 车头方向与速度方向确实分离
    expect(Math.abs(s.heading - s.travelHeading)).toBeGreaterThan(0.1);
  });

  it('侧向惯性维持：滑移角不会在单帧内被抹平', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.6, brake: 0, gear: 3 }, 0.8);
    const before = Math.abs(car.state.slipAngle);
    expect(before).toBeGreaterThan(0.3);

    // 松油门滑行 0.1 秒（仍在漂移），滑移角应基本保持（惯性维持）
    run(car, { steer: 1, throttle: 0, brake: 0, gear: 3 }, 0.1);
    expect(Math.abs(car.state.slipAngle)).toBeGreaterThan(before * 0.7);
  });

  it('出弯自动回正：方向回正后滑移角单调收敛到 0', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.5, brake: 0, gear: 3 }, 0.8);
    expect(Math.abs(car.state.slipAngle)).toBeGreaterThan(0.3);

    let last = Math.abs(car.state.slipAngle);
    let nonIncreasing = 0;
    for (let i = 0; i < 240; i++) {
      car.update({ steer: 0, throttle: 0.3, brake: 0, gear: 3 }, 1 / 60);
      const now = Math.abs(car.state.slipAngle);
      if (now <= last + 1e-9) nonIncreasing++;
      last = now;
    }
    expect(last).toBeLessThan(0.02);
    expect(car.state.isDrifting).toBe(false);
    // 回正过程基本单调（允许极少数数值抖动）
    expect(nonIncreasing).toBeGreaterThan(230);
  });

  it('反打方向可以主动收漂并压回对侧', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.6, brake: 0, gear: 3 }, 0.8);
    const before = car.state.slipAngle;
    expect(before).toBeGreaterThan(0.3);

    // 反打：车头往滑移的反方向转，滑移角被主动收回来
    run(car, { steer: -0.6, throttle: 0.4, brake: 0, gear: 3 }, 0.5);
    expect(Math.abs(car.state.slipAngle)).toBeLessThan(Math.abs(before) * 0.4);

    // 随即松手，车辆回到纯抓地行驶
    run(car, { steer: 0, throttle: 0.3, brake: 0, gear: 3 }, 2);
    expect(Math.abs(car.state.slipAngle)).toBeLessThan(0.03);
  });

  it('滑移角上限保护：持续满舵不会原地打转', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    for (let i = 0; i < 60 * 8; i++) {
      car.update({ steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1 / 60);
      expect(Math.abs(car.state.slipAngle)).toBeLessThanOrEqual(
        DEFAULT_CAR_CONFIG.maxSlipAngle + 1e-9,
      );
    }
    // 仍然在向前走，没有变成原地打转
    expect(car.state.speed).toBeGreaterThan(DEFAULT_CAR_CONFIG.driftSpeedThreshold);
  });

  it('侧滑会额外损耗前进速度（漂移损速系数生效）', () => {
    const driftInput: ControlPacket = { steer: 1, throttle: 0.5, brake: 0, gear: 3 };
    const noLoss = new CarPhysics({ driftSpeedLoss: 0 });
    const withLoss = new CarPhysics({ driftSpeedLoss: 4 });
    for (const car of [noLoss, withLoss]) {
      accelerate(car, 4, 4);
      run(car, driftInput, 1.5);
    }
    expect(withLoss.state.speed).toBeLessThan(noLoss.state.speed);
  });

  it('漂移强度在漂移中上升、结束后归零', () => {
    const car = new CarPhysics();
    accelerate(car, 4, 4);
    run(car, { steer: 1, throttle: 0.8, brake: 0, gear: 3 }, 1);
    expect(car.getDriftIntensity()).toBeGreaterThan(0.6);
    expect(car.state.driftIntensity).toBeLessThanOrEqual(1);

    run(car, { steer: 0, throttle: 0, brake: 1, gear: 3 }, 4);
    expect(car.getDriftIntensity()).toBe(0);
  });
});

describe('CarPhysics — 高低速转向手感', () => {
  it('同样满舵输入下，低速转向角明显大于高速', () => {
    const low = new CarPhysics();
    low.state.speed = 8;
    run(low, { steer: 1, throttle: 0, brake: 0, gear: 1 }, 1);

    const high = new CarPhysics();
    high.state.speed = 45;
    run(high, { steer: 1, throttle: 0, brake: 0, gear: 4 }, 0.3);

    expect(Math.abs(low.state.steerAngle)).toBeGreaterThan(Math.abs(high.state.steerAngle));
    // 高速最大转向角被明显压低（衰减后不足低速的一半）
    expect(Math.abs(high.state.steerAngle)).toBeLessThan(Math.abs(low.state.steerAngle) * 0.6);
  });

  it('低速增益让静止满舵转向角大于基础最大转向角', () => {
    const car = new CarPhysics();
    run(car, { steer: 1, throttle: 0, brake: 0, gear: 1 }, 0.5);
    expect(car.state.speed).toBe(0);
    expect(car.state.steerAngle).toBeGreaterThan(DEFAULT_CAR_CONFIG.maxSteerAngle);
    expect(car.state.steerAngle).toBeLessThanOrEqual(
      DEFAULT_CAR_CONFIG.maxSteerAngle * DEFAULT_CAR_CONFIG.lowSpeedSteerGain + 1e-9,
    );
  });

  it('低速转向不会产生漂移滑移（抓地力下限保护）', () => {
    for (const speed of [3, 6, 10]) {
      const car = new CarPhysics();
      runAtSpeed(car, speed, { steer: 1, throttle: 0.5, brake: 0, gear: 1 }, 2);
      expect(Math.abs(car.state.slipAngle), `${speed} m/s`).toBeLessThan(0.05);
      expect(car.state.isDrifting, `${speed} m/s`).toBe(false);
    }
  });
});

describe('CarPhysics — 网络输入平滑（阶段二）', () => {
  it('smoothInput：与帧率无关的指数平滑，踩下比松开更快', () => {
    const dt = 1 / 60;
    // 0 → 1：attackRate
    let up = 0;
    for (let i = 0; i < 6; i++) up = smoothInput(up, 1, dt, 12, 7);
    // 1 → 0：releaseRate
    let down = 1;
    for (let i = 0; i < 6; i++) down = smoothInput(down, 0, dt, 12, 7);
    // 上升幅度应大于下降幅度（同样帧数）
    expect(up).toBeGreaterThan(1 - down);
    expect(up).toBeGreaterThan(0.5);
  });

  it('smoothInput：满舵直接反打按快速率处理（不能因为反打变迟钝）', () => {
    const dt = 1 / 60;
    let v = 1;
    for (let i = 0; i < 3; i++) v = smoothInput(v, -1, dt, 12, 7);
    // 3 帧内必须明显越过了 0（快速率）
    expect(v).toBeLessThan(0.3);
  });

  it('油门阶跃响应：短时间内即可接近目标（低延迟）', () => {
    const car = new CarPhysics();
    run(car, { steer: 0, throttle: 1, brake: 0, gear: 1 }, 0.2);
    expect(car.getSmoothedInput().throttle).toBeGreaterThan(0.9);
  });

  it('抖动抑制：30Hz 高频抖动的输入不会引起同等幅度的抖动', () => {
    const car = new CarPhysics();
    const dt = 1 / 60;
    let maxSmoothed = 0;
    let maxDelta = 0;
    let prev = 0;
    for (let i = 0; i < 60; i++) {
      // 每帧在 ±0.12 之间跳变，模拟网络包/传感器抖动
      const noisy = i % 2 === 0 ? 0.12 : -0.12;
      car.update({ steer: noisy, throttle: 0, brake: 0, gear: 1 }, dt);
      const s = car.getSmoothedInput().steer;
      maxSmoothed = Math.max(maxSmoothed, Math.abs(s));
      maxDelta = Math.max(maxDelta, Math.abs(s - prev));
      prev = s;
    }
    // 抖动的输入被显著压小
    expect(maxSmoothed).toBeLessThan(0.12);
    // 且输出是平滑推进的，不会逐帧跳变
    expect(maxDelta).toBeLessThan(0.03);
  });

  it('松开方向后转向输入平滑衰减回中', () => {
    const car = new CarPhysics();
    run(car, { steer: 1, throttle: 0.3, brake: 0, gear: 1 }, 1);
    expect(car.getSmoothedInput().steer).toBeGreaterThan(0.9);

    run(car, { steer: 0, throttle: 0.3, brake: 0, gear: 1 }, 1.5);
    expect(Math.abs(car.getSmoothedInput().steer)).toBeLessThan(0.05);
  });

  it('reset 清空平滑输入状态', () => {
    const car = new CarPhysics();
    run(car, { steer: 1, throttle: 1, brake: 1, gear: 1 }, 1);
    car.reset();
    expect(car.getSmoothedInput()).toEqual({ steer: 0, throttle: 0, brake: 0 });
  });
});
