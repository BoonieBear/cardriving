/**
 * @vitest-environment jsdom
 *
 * AutoPilot 辅助驾驶 / 全自动驾驶单元测试
 * 覆盖：模式切换、前视点感知、避障规划、弯道限速、自动换挡、
 *       辅助与全自动的纵向控制差异、手动模式直通、边界条件
 */
import { describe, it, expect } from 'vitest';
import {
  AutoPilot,
  DEFAULT_AUTOPILOT_CONFIG,
  DISCONNECT_TAKEOVER_MODE,
  DRIVE_MODES,
  DRIVE_MODE_LABELS,
  cycleDriveMode,
  isAutonomousMode,
  isDriveMode,
  normalizeDriveMode,
  resolveActiveDriveMode,
  estimateRpm,
  normalizeAngle,
  type DriveMode,
} from './AutoPilot';
import { Track, createDefaultTrack } from '../core/Track';
import { CarPhysics } from './CarPhysics';
import type { CarState } from './CarPhysics';
import type { ControlPacket } from '../../../shared/protocol';

// ========== 测试夹具 ==========

function makeState(over: Partial<CarState> = {}): CarState {
  return {
    x: 0, z: 0, y: 0,
    heading: 0,
    travelHeading: 0,
    speed: 20,
    lateralSpeed: 0,
    slipAngle: 0,
    driftIntensity: 0,
    yawRate: 0,
    steerAngle: 0,
    currentGear: 3,
    isDrifting: false,
    rpm: 0.5,
    ...over,
  };
}

const NO_INPUT: ControlPacket = { steer: 0, throttle: 0, brake: 0, gear: 1 };

/** 一条正北直道：从 (0,0) 到 (0,400)，宽 12 */
function straightTrack(): Track {
  return new Track(
    [
      { x: 0, z: 0 },
      { x: 0, z: 100 },
      { x: 0, z: 200 },
      { x: 0, z: 300 },
      { x: 0, z: 400 },
    ],
    12,
  );
}

/** 一条 90° 弯道：先向北，再折向东 */
function cornerTrack(): Track {
  const pts = [];
  for (let z = 0; z <= 200; z += 20) pts.push({ x: 0, z });
  for (let x = 20; x <= 200; x += 20) pts.push({ x, z: 200 });
  return new Track(pts, 12);
}

// ========== 模式定义 ==========

describe('AutoPilot — 驾驶模式', () => {
  it('三种模式的定义与顺序固定为 手动 → 辅助 → 自动', () => {
    expect(DRIVE_MODES).toEqual(['manual', 'assist', 'auto']);
    expect(DRIVE_MODE_LABELS.assist).toBe('辅助驾驶');
    expect(DRIVE_MODE_LABELS.auto).toBe('全自动驾驶');
  });

  it('isDriveMode 只接受三种合法值', () => {
    expect(isDriveMode('manual')).toBe(true);
    expect(isDriveMode('assist')).toBe(true);
    expect(isDriveMode('auto')).toBe(true);
    expect(isDriveMode('AUTO')).toBe(false);
    expect(isDriveMode(null)).toBe(false);
    expect(isDriveMode(1)).toBe(false);
    expect(isDriveMode(undefined)).toBe(false);
  });

  it('normalizeDriveMode 对非法输入回退到 manual', () => {
    expect(normalizeDriveMode('auto')).toBe('auto');
    expect(normalizeDriveMode('乱码')).toBe('manual');
    expect(normalizeDriveMode(null)).toBe('manual');
  });

  it('cycleDriveMode 循环切换', () => {
    expect(cycleDriveMode('manual')).toBe('assist');
    expect(cycleDriveMode('assist')).toBe('auto');
    expect(cycleDriveMode('auto')).toBe('manual');
  });

  it('cycleDriveMode 支持反向步进', () => {
    expect(cycleDriveMode('manual', -1)).toBe('auto');
    expect(cycleDriveMode('assist', -1)).toBe('manual');
  });

  it('isAutonomousMode 只对辅助与全自动为真', () => {
    expect(isAutonomousMode('manual')).toBe(false);
    expect(isAutonomousMode('assist')).toBe(true);
    expect(isAutonomousMode('auto')).toBe(true);
  });

  it('每个模式都能被 cycleDriveMode 覆盖到（无死角）', () => {
    const seen = new Set<DriveMode>();
    let m: DriveMode = 'manual';
    for (let i = 0; i < DRIVE_MODES.length; i++) {
      seen.add(m);
      m = cycleDriveMode(m);
    }
    expect(seen.size).toBe(DRIVE_MODES.length);
    expect(m).toBe('manual'); // 一轮后回到起点
  });
});

// ========== 断线接管 ==========

/**
 * 回归：「控制端断开连接时自动切成自动驾驶，而不是缓缓停车」
 *
 * 旧行为：HostApp 调 engine.enterCoastMode()，引擎每帧执行
 * CarPhysics.coastToStop()，车辆以 0.15 的轻刹车缓缓减速到停止。
 * 新行为：断开时强制切到全自动驾驶，车辆继续沿赛道行驶。
 */
describe('AutoPilot — 断线接管为自动驾驶', () => {
  it('接管模式是全自动驾驶（不是辅助驾驶，也不是停车）', () => {
    expect(DISCONNECT_TAKEOVER_MODE).toBe('auto');
  });

  it('控制器断开时，无论玩家选的是哪个模式都会被强制接管', () => {
    for (const driveMode of DRIVE_MODES) {
      expect(
        resolveActiveDriveMode({ driveMode, hasAutoDriveSkill: false, disconnected: true }),
      ).toBe('auto');
    }
  });

  it('接管优先级高于「自动驾驶技能道具」', () => {
    expect(
      resolveActiveDriveMode({ driveMode: 'manual', hasAutoDriveSkill: true, disconnected: true }),
    ).toBe('auto');
  });

  it('未断开时保持玩家选择的模式不变', () => {
    expect(
      resolveActiveDriveMode({ driveMode: 'manual', hasAutoDriveSkill: false, disconnected: false }),
    ).toBe('manual');
    expect(
      resolveActiveDriveMode({ driveMode: 'assist', hasAutoDriveSkill: false, disconnected: false }),
    ).toBe('assist');
    expect(
      resolveActiveDriveMode({ driveMode: 'auto', hasAutoDriveSkill: false, disconnected: false }),
    ).toBe('auto');
  });

  it('未断开时，手动模式吃到技能道具提升为辅助驾驶（原有行为不变）', () => {
    expect(
      resolveActiveDriveMode({ driveMode: 'manual', hasAutoDriveSkill: true, disconnected: false }),
    ).toBe('assist');
    // 已经是辅助/全自动时，道具不改变模式
    expect(
      resolveActiveDriveMode({ driveMode: 'assist', hasAutoDriveSkill: true, disconnected: false }),
    ).toBe('assist');
    expect(
      resolveActiveDriveMode({ driveMode: 'auto', hasAutoDriveSkill: true, disconnected: false }),
    ).toBe('auto');
  });

  it('接管模式下 AutoPilot 会真正输出驱动车辆的控制量（不会像 coastToStop 那样刹车停车）', () => {
    const ap = new AutoPilot();
    const track = createDefaultTrack();
    const mode = resolveActiveDriveMode({
      driveMode: 'manual',
      hasAutoDriveSkill: false,
      disconnected: true,
    });
    expect(mode).toBe('auto');

    // 车静止在起点：全自动驾驶应当给油门起步，而不是刹车
    const out = ap.compute(
      makeState({ x: track.start.x, z: track.start.z, heading: track.startHeading, speed: 0 }),
      track,
      mode,
      { steer: 0, throttle: 0, brake: 0, gear: 1 },
      1 / 60,
      [],
    );
    expect(out.throttle).toBeGreaterThan(0);
    expect(out.brake).toBe(0);
  });

  it('接管期间车辆会继续行驶而不是停在原地（对照 coastToStop 会停车）', () => {
    const track = createDefaultTrack();
    const mode = DISCONNECT_TAKEOVER_MODE;

    // 自动驾驶：一路加速，位移显著
    const carAuto = new CarPhysics();
    carAuto.setTerrainHeight(() => 0);
    carAuto.reset(track.start.x, track.start.z, track.startHeading);
    const ap = new AutoPilot();
    for (let i = 0; i < 60 * 10; i++) {
      const inp = ap.compute(
        carAuto.state, track, mode,
        { steer: 0, throttle: 0, brake: 0, gear: carAuto.state.currentGear },
        1 / 60, [],
      );
      carAuto.update(inp, 1 / 60);
    }
    const distAuto = Math.hypot(carAuto.state.x - track.start.x, carAuto.state.z - track.start.z);

    // 旧行为对照：coastToStop 10 秒后会停下来
    const carCoast = new CarPhysics();
    carCoast.setTerrainHeight(() => 0);
    carCoast.reset(track.start.x, track.start.z, track.startHeading);
    for (let i = 0; i < 60 * 10; i++) carCoast.coastToStop(1 / 60);
    const distCoast = Math.hypot(carCoast.state.x - track.start.x, carCoast.state.z - track.start.z);

    // 接管后仍在行驶
    expect(carAuto.getSpeedKmh()).toBeGreaterThan(20);
    expect(distAuto).toBeGreaterThan(distCoast);
    // 旧的减速策略确实会停下（说明这个对照是有意义的）
    expect(carCoast.getSpeedKmh()).toBeLessThan(1);
  });
});

// ========== 感知 ==========

describe('AutoPilot — 前视点感知', () => {
  it('heading=0 时，正前方目标点的前向距离为正、横向偏移为 0', () => {
    const ap = new AutoPilot();
    const p = ap.perceiveTarget(makeState({ heading: 0 }), 0, 30);
    expect(p.forwardDist).toBeCloseTo(30, 6);
    expect(p.lateralOffset).toBeCloseTo(0, 6);
  });

  it('heading=0 时，右侧目标点的横向偏移为正（右向 = (cos h, -sin h)）', () => {
    const ap = new AutoPilot();
    const p = ap.perceiveTarget(makeState({ heading: 0 }), 5, 10);
    expect(p.lateralOffset).toBeCloseTo(5, 6);
    expect(p.forwardDist).toBeCloseTo(10, 6);
  });

  it('heading=90°（朝 +X）时，+Z 方向的目标落在车的左侧', () => {
    const ap = new AutoPilot();
    const p = ap.perceiveTarget(makeState({ heading: Math.PI / 2 }), 30, 0);
    expect(p.forwardDist).toBeCloseTo(30, 6);
    // 朝 +X 时右向为 (0,-1)，所以 +Z 目标横向偏移为 -z
    expect(p.lateralOffset).toBeCloseTo(0, 6);
    const q = ap.perceiveTarget(makeState({ heading: Math.PI / 2 }), 30, 4);
    expect(q.lateralOffset).toBeCloseTo(-4, 6);
  });

  it('车后方的目标前向距离为负', () => {
    const ap = new AutoPilot();
    const p = ap.perceiveTarget(makeState({ heading: 0 }), 0, -20);
    expect(p.forwardDist).toBeLessThan(0);
  });

  it('前视距离随车速增大且不超过上限', () => {
    const ap = new AutoPilot();
    expect(ap.getLookAheadDistance(40)).toBeGreaterThan(ap.getLookAheadDistance(0));
    expect(ap.getLookAheadDistance(1e6)).toBeLessThanOrEqual(DEFAULT_AUTOPILOT_CONFIG.maxLookAhead);
    expect(ap.getLookAheadDistance(0)).toBe(DEFAULT_AUTOPILOT_CONFIG.baseLookAhead);
  });

  it('getAimPoint 在直道上取到正前方偏右的赛道点（靠右行驶）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    // 车压在中线上（x=0），heading=0 朝 +Z，赛道右方便是世界 +X
    const aim = ap.getAimPoint(track, makeState({ x: 0, z: 50, heading: 0, speed: 10 }));
    expect(aim.forwardDist).toBeGreaterThan(0);
    // perceiveTarget 约定：lateralOffset 正 = 目标在车头右侧。
    // 旧行为恒为 0（瞄准中心线），右行交通应稳定落在右侧。
    expect(aim.lateralOffset).toBeCloseTo(ap.config.laneOffset, 3);
    expect(aim.lateralOffset).toBeGreaterThan(0);
  });

  it('getAimPoint 靠右偏移随赛道变窄而收窄，不会把车推下路基', () => {
    const ap = new AutoPilot();
    const narrow = new Track([{ x: 0, z: 0 }, { x: 0, z: 400 }], 6); // 半宽 3
    const aim = ap.getAimPoint(narrow, makeState({ x: 0, z: 50, heading: 0, speed: 10 }));
    expect(aim.lateralOffset).toBeGreaterThan(0);
    expect(aim.lateralOffset).toBeLessThanOrEqual(narrow.halfWidth * 0.6 + 1e-9);
  });
});

// ========== 靠右行驶 ==========

/**
 * 回归：「自动驾驶应靠右行驶」
 *
 * 旧实现总是瞄准赛道中心线（横向偏移恒为 0），车稳定骑在中线上。
 * 修复后目标点沿 perpRight 偏移 config.laneOffset，使车跑在右车道。
 */
describe('AutoPilot — 靠右行驶', () => {
  it('laneOffset 默认为正（右侧），且为 0 时退化为旧的居中行为', () => {
    const ap = new AutoPilot();
    expect(ap.config.laneOffset).toBeGreaterThan(0);

    const centered = new AutoPilot({ laneOffset: 0 });
    const track = straightTrack();
    const aim = centered.getAimPoint(track, makeState({ x: 0, z: 50, heading: 0, speed: 10 }));
    expect(aim.lateralOffset).toBeCloseTo(0, 6);
  });

  it('getLaneOffset 始终非负且不超过半宽的 60%', () => {
    const ap = new AutoPilot();
    for (const width of [4, 8, 12, 30]) {
      const t = new Track([{ x: 0, z: 0 }, { x: 0, z: 300 }], width);
      const off = ap.getLaneOffset(t);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThanOrEqual(t.halfWidth * 0.6 + 1e-9);
    }
  });

  it('车在中心线左侧时，转向指令把它往右推（负 steer）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    // Track.nearestPoint: lateralOffset>0 == 车在左侧。放在左侧 3 米处。
    const state = makeState({ x: 3, z: 50, heading: 0, speed: 15 });
    const out = ap.compute(state, track, 'auto', { steer: 0, throttle: 0, brake: 0, gear: 1 }, 1 / 60, []);
    // heading 增大 = 朝 +X（左）转；要往右（-X）修正则 steer 应为负
    expect(out.steer).toBeLessThan(0);
  });

  it('车在中心线右侧偏远时，转向指令把它往左拉（正 steer）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    // 右侧 5 米（超过 2.5 米的右行目标偏移，应当被拉回）
    const state = makeState({ x: -5, z: 50, heading: 0, speed: 15 });
    const out = ap.compute(state, track, 'auto', { steer: 0, throttle: 0, brake: 0, gear: 1 }, 1 / 60, []);
    expect(out.steer).toBeGreaterThan(0);
  });

  it('恰好位于右行目标线上时几乎没有横向修正（远小于居中时）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    const off = ap.getLaneOffset(track);
    const input = { steer: 0, throttle: 0, brake: 0, gear: 1 };

    // 目标线在中心线右侧 off 米处 -> 世界 x = -off
    const onTarget = makeState({ x: -off, z: 50, heading: 0, speed: 15 });
    const steerOnTarget = Math.abs(
      ap.compute(onTarget, track, 'auto', input, 1 / 60, []).steer,
    );

    // 对照：压在中心线上（横向误差正好一个 laneOffset）
    const centered = makeState({ x: 0, z: 50, heading: 0, speed: 15 });
    const steerCentered = Math.abs(
      ap.compute(centered, track, 'auto', input, 1 / 60, []).steer,
    );

    // 在目标线上时修正量应当显著小于偏离时
    expect(steerOnTarget).toBeLessThan(steerCentered);
    expect(steerOnTarget).toBeLessThan(0.15);
  });

  it('辅助驾驶同样靠右（不是只有全自动驾驶才偏移）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    const aim = ap.getAimPoint(track, makeState({ x: 0, z: 50, heading: 0, speed: 15 }));
    expect(aim.lateralOffset).toBeGreaterThan(0);

    // 左侧 4 米处，辅助模式也应给出向右的修正
    const state = makeState({ x: 4, z: 50, heading: 0, speed: 15 });
    const out = ap.compute(state, track, 'assist', { steer: 0, throttle: 0, brake: 0, gear: 1 }, 1 / 60, []);
    expect(out.steer).toBeLessThan(0);
  });
});

// ========== 避障 ==========

describe('AutoPilot — 避障', () => {
  it('前方无障碍时不触发避让', () => {
    const ap = new AutoPilot();
    const plan = ap.planAvoidance(makeState({ heading: 0, speed: 20 }), [], 6);
    expect(plan.active).toBe(false);
    expect(plan.lateralOffset).toBe(0);
    expect(plan.speedLimit).toBe(Infinity);
  });

  it('正前方障碍物触发避让，并让开车身+障碍半径', () => {
    const ap = new AutoPilot();
    const state = makeState({ x: 0, z: 0, heading: 0, speed: 20 });
    const plan = ap.planAvoidance(state, [{ x: 0, z: 20, radius: 1 }], 6);
    expect(plan.active).toBe(true);
    expect(Math.abs(plan.lateralOffset)).toBeGreaterThan(1.2 + 1);
    expect(plan.nearestDistance).toBeCloseTo(20, 6);
  });

  it('障碍物在车后方时忽略', () => {
    const ap = new AutoPilot();
    const plan = ap.planAvoidance(
      makeState({ x: 0, z: 0, heading: 0, speed: 20 }),
      [{ x: 0, z: -15, radius: 1 }],
      6,
    );
    expect(plan.active).toBe(false);
  });

  it('障碍物在探测距离之外时忽略', () => {
    const ap = new AutoPilot();
    const plan = ap.planAvoidance(
      makeState({ x: 0, z: 0, heading: 0, speed: 20 }),
      [{ x: 0, z: DEFAULT_AUTOPILOT_CONFIG.avoidLookAhead + 20, radius: 1 }],
      6,
    );
    expect(plan.active).toBe(false);
  });

  it('障碍物很近时给出限速，且限速值有限且为正', () => {
    const ap = new AutoPilot();
    const plan = ap.planAvoidance(
      makeState({ x: 0, z: 0, heading: 0, speed: 20 }),
      [{ x: 0, z: 8, radius: 1 }],
      6,
    );
    expect(plan.active).toBe(true);
    expect(Number.isFinite(plan.speedLimit)).toBe(true);
    expect(plan.speedLimit).toBeGreaterThan(0);
  });

  it('横向避让量被限制在 maxAvoidOffset 之内（不会开出赛道）', () => {
    const ap = new AutoPilot({ maxAvoidOffset: 3.6 });
    const plan = ap.planAvoidance(
      makeState({ x: 0, z: 0, heading: 0, speed: 20 }),
      [{ x: 0, z: 15, radius: 3 }],
      6,
    );
    expect(Math.abs(plan.lateralOffset)).toBeLessThanOrEqual(3.6 + 1e-9);
  });

  it('障碍物偏在右侧时从左侧绕行（避让量为负）', () => {
    const ap = new AutoPilot();
    const plan = ap.planAvoidance(
      makeState({ x: 0, z: 0, heading: 0, speed: 20 }),
      [{ x: 2.5, z: 20, radius: 0.8 }],
      8,
    );
    expect(plan.active).toBe(true);
    expect(plan.lateralOffset).toBeLessThan(2.5);
  });
});

// ========== 弯道限速 ==========

describe('AutoPilot — 弯道限速', () => {
  it('直道不额外限速（达到巡航速度）', () => {
    const ap = new AutoPilot();
    const track = straightTrack();
    const limit = ap.getCornerSpeedLimit(track, 50, 30);
    expect(limit).toBeCloseTo(DEFAULT_AUTOPILOT_CONFIG.cruiseSpeed, 6);
  });

  it('弯道限速显著低于直道，且不小于最低安全速度', () => {
    const ap = new AutoPilot();
    const track = cornerTrack();
    const limit = ap.getCornerSpeedLimit(track, 150, 30);
    expect(limit).toBeLessThan(DEFAULT_AUTOPILOT_CONFIG.cruiseSpeed);
    expect(limit).toBeGreaterThanOrEqual(8);
  });

  it('限速值永远落在 [8, cruiseSpeed] 区间内', () => {
    const ap = new AutoPilot();
    for (const track of [straightTrack(), cornerTrack(), createDefaultTrack()]) {
      for (let d = 0; d < track.totalLength; d += 17) {
        const v = ap.getCornerSpeedLimit(track, d, 25);
        expect(v).toBeGreaterThanOrEqual(8);
        expect(v).toBeLessThanOrEqual(DEFAULT_AUTOPILOT_CONFIG.cruiseSpeed);
      }
    }
  });
});

// ========== 自动换挡 ==========

describe('AutoPilot — 自动换挡', () => {
  it('低速起步使用 1 挡', () => {
    const ap = new AutoPilot();
    expect(ap.chooseGear(0.2, 3, 0, 1)).toBe(1);
  });

  it('高转速升挡', () => {
    const ap = new AutoPilot();
    // 3 挡 maxSpeed=52，速度 50 → rpm≈0.96
    expect(ap.chooseGear(50, 3, 0.96, 1)).toBe(4);
  });

  it('5 挡不会继续升挡', () => {
    const ap = new AutoPilot();
    expect(ap.chooseGear(70, 5, 0.95, 1)).toBe(-1);
  });

  it('转速过低降挡', () => {
    const ap = new AutoPilot();
    expect(ap.chooseGear(12, 4, 0.18, 0.5)).toBe(3);
  });

  it('1 挡不会继续降挡', () => {
    const ap = new AutoPilot();
    expect(ap.chooseGear(5, 1, 0.05, 0.2)).toBe(-1);
  });

  it('换挡冷却期内不再换挡（防止连跳）', () => {
    const ap = new AutoPilot();
    const state = makeState({ speed: 50, currentGear: 3, steerAngle: 0 });
    const track = straightTrack();
    ap.compute(state, track, 'auto', NO_INPUT, 0.016, []);
    const gearAfterShift = ap.getGear();
    // 立刻再来一帧，应当仍在冷却中，不会再次换挡
    const gearNext = ap.chooseGear(50, gearAfterShift, 0.96, 1);
    expect(gearNext).toBe(-1);
  });

  it('estimateRpm 与挡位极速一致', () => {
    expect(estimateRpm(0, 3)).toBe(0);
    expect(estimateRpm(52, 3)).toBeCloseTo(1, 6);
    expect(estimateRpm(26, 3)).toBeCloseTo(0.5, 6);
    expect(estimateRpm(10, 0)).toBe(0); // 空挡无转速
  });
});

// ========== 控制输出 ==========

describe('AutoPilot — 手动模式直通', () => {
  it('manual 模式原样返回玩家输入', () => {
    const ap = new AutoPilot();
    const input: ControlPacket = { steer: -0.6, throttle: 1, brake: 0, gear: 4 };
    const out = ap.compute(makeState(), straightTrack(), 'manual', input, 0.016, []);
    expect(out).toEqual(input);
  });

  it('manual 模式不修改玩家挡位（返回的是副本，不共享引用）', () => {
    const ap = new AutoPilot();
    const input: ControlPacket = { steer: 0, throttle: 0, brake: 0, gear: 2 };
    const out = ap.compute(makeState(), straightTrack(), 'manual', input, 0.016, []);
    expect(out.gear).toBe(2);
    expect(out).not.toBe(input);
  });
});

describe('AutoPilot — 全自动驾驶纵向控制', () => {
  it('低于目标速度时给油', () => {
    const ap = new AutoPilot();
    const out = ap.compute(
      makeState({ speed: 5, heading: 0, currentGear: 1 }),
      straightTrack(), 'auto', NO_INPUT, 0.016, [],
    );
    expect(out.throttle).toBeGreaterThan(0);
    expect(out.brake).toBe(0);
  });

  it('严重超速时刹车', () => {
    const ap = new AutoPilot();
    // 弯道 + 高速 → 必须刹车
    const out = ap.compute(
      makeState({ x: 0, z: 150, heading: 0, speed: 55, currentGear: 5 }),
      cornerTrack(), 'auto', NO_INPUT, 0.016, [],
    );
    expect(out.brake).toBeGreaterThan(0);
  });

  it('输出字段全部落在协议合法区间内', () => {
    const ap = new AutoPilot();
    const tracks = [straightTrack(), cornerTrack(), createDefaultTrack()];
    for (const track of tracks) {
      for (const speed of [0, 5, 20, 45, 60]) {
        const out = ap.compute(
          makeState({ x: 0, z: 60, speed, currentGear: 3 }),
          track, 'auto', NO_INPUT, 0.016, [],
        );
        expect(out.steer).toBeGreaterThanOrEqual(-1);
        expect(out.steer).toBeLessThanOrEqual(1);
        expect(out.throttle).toBeGreaterThanOrEqual(0);
        expect(out.throttle).toBeLessThanOrEqual(1);
        expect(out.brake).toBeGreaterThanOrEqual(0);
        expect(out.brake).toBeLessThanOrEqual(1);
        expect(Number.isInteger(out.gear)).toBe(true);
        expect(out.gear).toBeGreaterThanOrEqual(1);
        expect(out.gear).toBeLessThanOrEqual(5);
      }
    }
  });

  it('连续运行 600 帧输出保持有限值（无 NaN / Infinity）', () => {
    const ap = new AutoPilot();
    const track = createDefaultTrack();
    const state = makeState({ x: track.start.x, z: track.start.z, heading: track.startHeading, speed: 0, currentGear: 1 });
    for (let i = 0; i < 600; i++) {
      const out = ap.compute(state, track, 'auto', NO_INPUT, 1 / 60, []);
      expect(Number.isFinite(out.steer)).toBe(true);
      expect(Number.isFinite(out.throttle)).toBe(true);
      expect(Number.isFinite(out.brake)).toBe(true);
      expect(Number.isFinite(out.gear)).toBe(true);
      // 简单推进车辆状态，避免原地不动
      state.speed = 15;
      state.heading += out.steer * 0.02;
      state.x += Math.sin(state.heading) * state.speed / 60;
      state.z += Math.cos(state.heading) * state.speed / 60;
    }
  });
});

describe('AutoPilot — 辅助驾驶与全自动驾驶的差异', () => {
  it('辅助驾驶不主动巡航：玩家松油门且未偏航时不猛给油', () => {
    const ap = new AutoPilot();
    const out = ap.compute(
      makeState({ speed: 15, heading: 0, currentGear: 3 }),
      straightTrack(), 'assist', NO_INPUT, 0.016, [],
    );
    // 直道居中，系统处于「守航」状态，不应把油门踩满
    expect(out.throttle).toBeLessThanOrEqual(DEFAULT_AUTOPILOT_CONFIG.assistThrottle);
  });

  it('辅助驾驶尊重玩家油门（系统只做补足，不做超越）', () => {
    const ap = new AutoPilot();
    const out = ap.compute(
      makeState({ speed: 10, heading: 0, currentGear: 2 }),
      straightTrack(), 'assist',
      { steer: 0, throttle: 1, brake: 0, gear: 2 }, 0.016, [],
    );
    expect(out.throttle).toBeCloseTo(1, 6);
  });

  it('辅助驾驶下玩家刹车优先，系统不会顶油门', () => {
    const ap = new AutoPilot();
    const out = ap.compute(
      makeState({ speed: 30, heading: 0, currentGear: 4 }),
      straightTrack(), 'assist',
      { steer: 0, throttle: 1, brake: 1, gear: 4 }, 0.016, [],
    );
    expect(out.brake).toBeCloseTo(1, 6);
    expect(out.throttle).toBeLessThanOrEqual(0.2);
  });

  it('辅助驾驶会接管转向：玩家乱打方向时系统仍朝赛道修正', () => {
    const ap = new AutoPilot();
    const state = makeState({ x: 3, z: 50, heading: 0.5, speed: 20, currentGear: 3 });
    const out = ap.compute(
      state, straightTrack(), 'assist',
      { steer: 1, throttle: 0.5, brake: 0, gear: 3 }, 0.016, [],
    );
    // 车头偏向 +X 且位于中心线右侧，系统应向左修正（steer < 玩家给的 1）
    expect(out.steer).toBeLessThan(1);
  });

  it('严重偏离赛道时辅助驾驶介入减速', () => {
    const ap = new AutoPilot();
    const state = makeState({ x: 30, z: 120, heading: 1.2, speed: 40, currentGear: 4 });
    const out = ap.compute(state, straightTrack(), 'assist', NO_INPUT, 0.016, []);
    expect(out.brake).toBeGreaterThan(0);
  });

  it('避障在两种自动模式下都会生效（横向让位）', () => {
    for (const mode of ['assist', 'auto'] as DriveMode[]) {
      const ap = new AutoPilot();
      const state = makeState({ x: 0, z: 0, heading: 0, speed: 20, currentGear: 3 });
      const withObs = ap.compute(state, straightTrack(), mode, NO_INPUT, 0.016, [
        { x: 0, z: 18, radius: 1.5 },
      ]);
      const without = new AutoPilot().compute(
        state, straightTrack(), mode, NO_INPUT, 0.016, [],
      );
      expect(withObs.steer).not.toBeCloseTo(without.steer, 3);
    }
  });
});

// ========== 边界与健壮性 ==========

describe('AutoPilot — 边界条件', () => {
  it('dt=0 不会产生 NaN', () => {
    const ap = new AutoPilot();
    const out = ap.compute(makeState(), straightTrack(), 'auto', NO_INPUT, 0, []);
    expect(Number.isFinite(out.steer)).toBe(true);
    expect(Number.isFinite(out.throttle)).toBe(true);
  });

  it('超大 dt 被夹紧，不会让平滑量爆掉', () => {
    const ap = new AutoPilot();
    const out = ap.compute(makeState(), straightTrack(), 'auto', NO_INPUT, 5, []);
    expect(out.steer).toBeGreaterThanOrEqual(-1);
    expect(out.steer).toBeLessThanOrEqual(1);
  });

  it('倒车（负速度）时不会请求倒挡或空挡', () => {
    const ap = new AutoPilot();
    const out = ap.compute(
      makeState({ speed: -5, heading: 0, currentGear: 1 }),
      straightTrack(), 'auto', NO_INPUT, 0.016, [],
    );
    expect(out.gear).toBeGreaterThanOrEqual(1);
  });

  it('reset 会清空平滑量与自动挡位', () => {
    const ap = new AutoPilot();
    ap.compute(makeState({ speed: 50, heading: 0.4 }), straightTrack(), 'auto', NO_INPUT, 0.016, []);
    ap.reset(2);
    expect(ap.getGear()).toBe(2);
    const out = ap.compute(makeState({ speed: 0, heading: 0 }), straightTrack(), 'auto', NO_INPUT, 0.016, []);
    expect(Math.abs(out.steer)).toBeLessThan(0.2);
  });

  it('自定义配置会与默认配置合并', () => {
    const ap = new AutoPilot({ cruiseSpeed: 20 });
    expect(ap.config.cruiseSpeed).toBe(20);
    expect(ap.config.curveSpeed).toBe(DEFAULT_AUTOPILOT_CONFIG.curveSpeed);
  });

  it('normalizeAngle 把任意角折算到 [-PI, PI]', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0, 9);
    expect(normalizeAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
    // ±PI 是同一个角度，归一化结果落在哪一侧都合法
    expect(Math.abs(Math.abs(normalizeAngle(3 * Math.PI)) - Math.PI)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(normalizeAngle(-3 * Math.PI)) - Math.PI)).toBeLessThan(1e-9);
    for (const a of [100, -100, 7.5, -0.0001, 1e6]) {
      const n = normalizeAngle(a);
      expect(n).toBeGreaterThanOrEqual(-Math.PI);
      expect(n).toBeLessThanOrEqual(Math.PI);
      // 归一化必须是等价角（相差 2π 的整数倍）。
      // 反复做 2π 减法会累积浮点误差，容差随 |a| 放大。
      const k = Math.round((a - n) / (2 * Math.PI));
      expect(Math.abs(a - n - k * 2 * Math.PI)).toBeLessThan(1e-6 * (1 + Math.abs(a)));
    }
  });

  it('赛道长度极短时不崩溃', () => {
    const ap = new AutoPilot();
    const tiny = new Track([{ x: 0, z: 0 }, { x: 0, z: 3 }], 12);
    const out = ap.compute(makeState({ speed: 10 }), tiny, 'auto', NO_INPUT, 0.016, []);
    expect(Number.isFinite(out.steer)).toBe(true);
  });
});
