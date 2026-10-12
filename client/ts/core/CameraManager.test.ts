/**
 * CameraManager 单元测试（阶段二）
 * 覆盖：视角切换、机位预设、平滑插值、最短弧朝向、防穿模、俯视过渡量
 */
import { describe, it, expect } from 'vitest';
import {
  CameraManager,
  CAMERA_MODES,
  CAMERA_PRESETS,
  CAMERA_MODE_LABELS,
  CAMERA_MODE_SHORT,
  COCKPIT_HEIGHT_MAX,
  cycleCameraMode,
  isCameraMode,
  type CameraMode,
} from './CameraManager';

/** 平坦地面 */
const flat = () => 0;
/** 起伏丘陵（与渲染器地形同量级） */
const hills = (x: number, z: number) =>
  Math.sin(x * 0.04) * 2.5 + Math.sin(z * 0.03 + 1) * 3.5 + Math.sin((x + z) * 0.02) * 2 + Math.sin(x * 0.08 - z * 0.06) * 1;

const DT = 1 / 60;

describe('CameraManager — 模式与常量', () => {
  it('默认视角为车尾跟随', () => {
    expect(new CameraManager().getMode()).toBe('chase');
  });

  it('三种视角顺序与标签完整', () => {
    expect(CAMERA_MODES).toEqual(['cockpit', 'chase', 'top']);
    for (const m of CAMERA_MODES) {
      expect(CAMERA_MODE_LABELS[m].length).toBeGreaterThan(0);
      expect(CAMERA_MODE_SHORT[m].length).toBeGreaterThan(0);
    }
  });

  it('isCameraMode 校验', () => {
    expect(isCameraMode('top')).toBe(true);
    expect(isCameraMode('cockpit')).toBe(true);
    expect(isCameraMode('chase')).toBe(true);
    expect(isCameraMode('free')).toBe(false);
    expect(isCameraMode(null)).toBe(false);
  });

  it('cycleCameraMode 正反向循环且取模', () => {
    expect(cycleCameraMode('cockpit')).toBe('chase');
    expect(cycleCameraMode('chase')).toBe('top');
    expect(cycleCameraMode('top')).toBe('cockpit');
    expect(cycleCameraMode('cockpit', -1)).toBe('top');
    expect(cycleCameraMode('top', 3)).toBe('top');
    expect(cycleCameraMode('top', 7)).toBe('cockpit');
  });

  it('setMode 忽略非法值', () => {
    const cm = new CameraManager();
    cm.setMode('cockpit');
    expect(cm.getMode()).toBe('cockpit');
    cm.setMode('bogus' as CameraMode);
    expect(cm.getMode()).toBe('cockpit');
  });

  it('cycle 返回新视角并更新状态', () => {
    const cm = new CameraManager();
    expect(cm.cycle()).toBe('top');
    expect(cm.cycle()).toBe('cockpit');
    expect(cm.getMode()).toBe('cockpit');
  });

  it('预设表数值合法（三种视角都有正高度、有界速率）', () => {
    for (const m of CAMERA_MODES) {
      const p = CAMERA_PRESETS[m];
      expect(p.height, m).toBeGreaterThan(0);
      expect(p.clearance, m).toBeGreaterThan(0);
      expect(p.followRate, m).toBeGreaterThan(0);
      expect(p.yawRate, m).toBeGreaterThan(0);
      expect(p.pitchRate, m).toBeGreaterThan(0);
      expect(Number.isFinite(p.behind), m).toBe(true);
      expect(p.pitch, m).toBeLessThanOrEqual(0);
    }
    // 俯视必须比车尾更高、俯角更陡
    expect(CAMERA_PRESETS.top.height).toBeGreaterThan(CAMERA_PRESETS.chase.height);
    expect(CAMERA_PRESETS.top.pitch).toBeLessThan(CAMERA_PRESETS.chase.pitch);
    // 车内必须贴近座舱
    expect(CAMERA_PRESETS.cockpit.height).toBeLessThan(COCKPIT_HEIGHT_MAX);
  });
});

describe('CameraManager — 机位求解（首帧吸附）', () => {
  it('车尾跟随：机位在车后方 6.5 米、相对车辆地面抬高 3.2 米', () => {
    const cm = new CameraManager();
    const st = cm.update(10, 20, 0, DT, flat);
    expect(st.x).toBeCloseTo(10, 6);
    expect(st.z).toBeCloseTo(20 - 6.5, 6);
    expect(st.y).toBeCloseTo(3.2, 6);
    expect(st.pitch).toBeCloseTo(CAMERA_PRESETS.chase.pitch, 6);
  });

  it('机位随车头方向旋转（heading=π/2 时机位在车的 −X 侧）', () => {
    const cm = new CameraManager();
    const st = cm.update(0, 0, Math.PI / 2, DT, flat);
    expect(st.x).toBeCloseTo(-6.5, 5);
    expect(st.z).toBeCloseTo(0, 5);
    expect(st.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('车内视角：贴近座舱、几乎平视', () => {
    const cm = new CameraManager();
    cm.setMode('cockpit');
    const st = cm.update(0, 0, 0, DT, flat);
    expect(st.y).toBeCloseTo(CAMERA_PRESETS.cockpit.height, 6);
    expect(Math.abs(st.pitch)).toBeLessThan(0.1);
    cm.reset();
    cm.setMode('top');
    // 复位后切换视角同样立即吸附
    const top = cm.update(0, 0, 0, DT, flat);
    expect(top.y).toBeCloseTo(CAMERA_PRESETS.top.height, 6);
  });

  it('上帝俯视：高机位大俯角', () => {
    const cm = new CameraManager();
    cm.setMode('top');
    const st = cm.update(0, 0, 0, DT, flat);
    expect(st.y).toBeCloseTo(30, 6);
    expect(st.pitch).toBeCloseTo(-1.02, 6);
    expect(st.z).toBeCloseTo(-13, 6);
  });
});

describe('CameraManager — 平滑插值', () => {
  it('切换视角后单帧只推进一小段（不平移瞬移）', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat); // 先吸附到车尾
    cm.setMode('top');
    const mid = cm.update(0, 0, 0, DT, flat);
    expect(mid.y).toBeGreaterThan(3.2);
    expect(mid.y).toBeLessThan(9);
    expect(Math.abs(mid.pitch - CAMERA_PRESETS.chase.pitch)).toBeLessThan(0.4);
  });

  it('持续多帧后收敛到目标机位', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    cm.setMode('top');
    let st = cm.getState();
    for (let i = 0; i < 600; i++) st = cm.update(0, 0, 0, DT, flat);
    expect(st.y).toBeCloseTo(30, 1);
    expect(st.z).toBeCloseTo(-13, 1);
    expect(st.pitch).toBeCloseTo(-1.02, 3);
  });

  it('与帧率无关：大 dt 一步推进更多', () => {
    const a = new CameraManager();
    a.update(0, 0, 0, DT, flat);
    a.setMode('top');
    const slow = a.update(0, 0, 0, DT, flat);

    const b = new CameraManager();
    b.update(0, 0, 0, DT, flat);
    b.setMode('top');
    const fast = b.update(0, 0, 0, 0.2, flat);

    expect(fast.y).toBeGreaterThan(slow.y);
  });

  it('dt=0 不推进也不产生 NaN', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    const before = cm.getState();
    const after = cm.update(0, 0, 0, 0, flat);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(Number.isFinite(after.y)).toBe(true);
    expect(Number.isFinite(after.pitch)).toBe(true);
  });

  it('朝向走最短弧，跨越 ±π 不会绕远路', () => {
    const cm = new CameraManager();
    cm.update(0, 0, Math.PI - 0.05, DT, flat);
    expect(cm.getState().yaw).toBeCloseTo(Math.PI - 0.05, 6);

    for (let i = 0; i < 120; i++) cm.update(0, 0, -Math.PI + 0.05, DT, flat);
    const yaw = cm.getState().yaw;
    // 应该稳定在 -π（等价 +π）附近，而不是绕到 0 附近
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.1);
  });

  it('朝向平滑跟随：单帧不会瞬间对齐到新航向', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    const st = cm.update(0, 0, 1.0, DT, flat);
    expect(st.yaw).toBeGreaterThan(0);
    expect(st.yaw).toBeLessThan(0.4);
  });
});

describe('CameraManager — 防穿模', () => {
  it('相机始终高于其所在地形（车尾视角）', () => {
    const cm = new CameraManager();
    for (let i = -30; i <= 30; i++) {
      const st = cm.update(i * 4, i * 7, i * 0.4, DT, hills);
      expect(st.y, `i=${i}`).toBeGreaterThanOrEqual(hills(st.x, st.z));
    }
  });

  it('相机始终高于其所在地形（三种视角 + 大 dt 过渡中）', () => {
    for (const mode of CAMERA_MODES) {
      const cm = new CameraManager();
      cm.setMode(mode);
      for (let i = 0; i < 60; i++) {
        const st = cm.update(i * 5, -i * 3, i * 0.25, 0.05, hills);
        expect(st.y, `${mode} i=${i}`).toBeGreaterThanOrEqual(hills(st.x, st.z));
      }
    }
  });

  it('地形高于目标机位时把相机顶起来（保留最小离地间隙）', () => {
    const cm = new CameraManager();
    // 车尾后方 20 米处地形极高
    const wall = (x: number, z: number) => (z < -5 ? 100 : 0);
    const st = cm.update(0, 0, 0, DT, wall);
    expect(st.y).toBeGreaterThanOrEqual(100);
  });
});

describe('CameraManager — 俯视过渡与车内判定', () => {
  it('topDownBlend：车尾/车内为 0，俯视为 1', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.topDownBlend()).toBe(0);

    cm.setMode('cockpit');
    cm.reset();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.topDownBlend()).toBe(0);

    cm.setMode('top');
    cm.reset();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.topDownBlend()).toBe(1);
  });

  it('俯视过渡量在两帧之间连续变化（不会从 0 直接跳到 1）', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    cm.setMode('top');
    const blends: number[] = [];
    for (let i = 0; i < 120; i++) {
      cm.update(0, 0, 0, DT, flat);
      blends.push(cm.topDownBlend());
    }
    const maxJump = blends.reduce((m, v, i) => (i === 0 ? m : Math.max(m, Math.abs(v - blends[i - 1]))), 0);
    expect(maxJump).toBeLessThan(0.2);
    expect(blends[blends.length - 1]).toBeCloseTo(1, 2);
  });

  it('isInsideCar：车内为 true，车尾/俯视为 false', () => {
    const cm = new CameraManager();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.isInsideCar(flat)).toBe(false);

    cm.setMode('cockpit');
    cm.reset();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.isInsideCar(flat)).toBe(true);

    cm.setMode('top');
    cm.reset();
    cm.update(0, 0, 0, DT, flat);
    expect(cm.isInsideCar(flat)).toBe(false);
  });

  it('reset 后下一帧重新吸附', () => {
    const cm = new CameraManager();
    cm.setMode('top');
    cm.update(0, 0, 0, DT, flat);
    expect(cm.getState().y).toBeCloseTo(30, 6);

    cm.setMode('chase');
    // 不 reset：需要若干帧才收敛
    const mid = cm.update(0, 0, 0, DT, flat);
    expect(mid.y).toBeGreaterThan(3.3);

    cm.reset();
    const snapped = cm.update(0, 0, 0, DT, flat);
    expect(snapped.y).toBeCloseTo(3.2, 6);
  });
});
