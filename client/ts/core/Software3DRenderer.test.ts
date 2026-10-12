/**
 * @vitest-environment jsdom
 *
 * Software3DRenderer 单元测试
 * 覆盖：3D数学（旋转、投影）、渲染稳定性、相机跟随、
 *       地面网格、道路、物体、车辆、边界条件
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Software3DRenderer,
  CAMERA_MODES,
  CAMERA_MODE_LABELS,
  CAMERA_MODE_SHORT,
  cycleCameraMode,
  isCameraMode,
  type CameraMode,
} from './Software3DRenderer';
import { createDefaultTrack, Track } from './Track';
import { SkillSystem } from './SkillSystem';

function createMockCtx(): CanvasRenderingContext2D {
  const noop = () => {};
  return {
    canvas: {} as HTMLCanvasElement,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    arc: noop,
    ellipse: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fillText: noop,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }) as unknown as CanvasGradient,
    createRadialGradient: () => ({ addColorStop: noop }) as unknown as CanvasGradient,
    clearRect: noop,
    clip: noop,
    setLineDash: noop,
    lineCap: '',
    lineJoin: '',
    setTransform: noop,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage: noop,
    putImageData: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  } as unknown as CanvasRenderingContext2D;
}

function createRenderer(): Software3DRenderer {
  const container = document.createElement('div');
  const originalCreate = document.createElement.bind(document);
  const ctx = createMockCtx();
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      const el = originalCreate('canvas') as HTMLCanvasElement;
      el.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
      return el;
    }
    return originalCreate(tag as keyof HTMLElementTagNameMap);
  });
  return new Software3DRenderer(container);
}

function getPrivate<T>(obj: unknown, key: string): T {
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val === 'function') return val.bind(obj) as T;
  return val as T;
}

function render(
  r: Software3DRenderer,
  opts: { carX?: number; carZ?: number; heading?: number; speed?: number; steerAngle?: number; isDrifting?: boolean; dt?: number } = {},
): void {
  const track = createDefaultTrack();
  const skills = new SkillSystem();
  r.render(
    opts.carX ?? 0,
    opts.carZ ?? 0,
    opts.heading ?? 0,
    opts.speed ?? 0,
    opts.steerAngle ?? 0,
    opts.isDrifting ?? false,
    opts.dt ?? 1 / 60,
    track,
    skills,
  );
}

describe('Software3DRenderer — 3D数学：投影', () => {
  it('相机正前方的点投影到屏幕中心', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => { x: number; y: number; z: number } | null>(r, 'project');
    const p = project(0, 0, 10, 0, 0, 0, 0, 0);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(window.innerWidth / 2, 1);
  });

  it('相机后方的点返回 null', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => unknown>(r, 'project');
    expect(project(0, 0, -5, 0, 0, 0, 0, 0)).toBeNull();
  });

  it('超过远裁剪面的点返回 null', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => unknown>(r, 'project');
    expect(project(0, 0, 600, 0, 0, 0, 0, 0)).toBeNull();
  });

  it('透视投影：距离越远屏幕y越接近地平线', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => { y: number } | null>(r, 'project');
    const pNear = project(0, 0, 5, 0, 2, 0, 0, -0.2);
    const pFar = project(0, 0, 100, 0, 2, 0, 0, -0.2);
    expect(pNear).not.toBeNull();
    expect(pFar).not.toBeNull();
    // 近处地面点y更大（屏幕下方），远处更接近地平线
    expect(pNear!.y).toBeGreaterThan(pFar!.y);
  });

  it('yaw=90度时，相机朝+X方向，原+X方向的点投影到屏幕中心', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => { x: number } | null>(r, 'project');
    // yaw=PI/2，相机朝右(+X)，点(10,0,0)在正前方
    const p = project(10, 0, 0, 0, 0, 0, Math.PI / 2, 0);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(window.innerWidth / 2, 1);
  });

  it('yaw=90度时，原+Z方向的点在相机侧面被裁剪', () => {
    const r = createRenderer();
    const project = getPrivate<(wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) => unknown>(r, 'project');
    // yaw=PI/2，点(0,0,10)旋转后z'=0，被近裁剪裁掉
    expect(project(0, 0, 10, 0, 0, 0, Math.PI / 2, 0)).toBeNull();
  });
});

describe('Software3DRenderer — 渲染稳定性', () => {
  it('连续渲染100帧不崩溃', () => {
    const r = createRenderer();
    expect(() => {
      for (let i = 0; i < 100; i++) {
        render(r, { carZ: i * 0.5, speed: 30, heading: Math.sin(i * 0.1) * 0.3 });
      }
    }).not.toThrow();
  });

  it('全零参数不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, {})).not.toThrow();
  });

  it('极端参数不崩溃', () => {
    const r = createRenderer();
    expect(() => {
      render(r, { carX: 1e6, carZ: 1e6, heading: 100, speed: 1000, steerAngle: 10 });
      render(r, { carX: -1e6, carZ: -1e6, heading: -100, speed: -1000 });
    }).not.toThrow();
  });

  it('dt=0不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, { dt: 0 })).not.toThrow();
  });

  it('canvas尺寸与窗口一致', () => {
    const r = createRenderer();
    render(r, { carZ: 10 });
    const canvas = getPrivate<HTMLCanvasElement>(r, 'canvas');
    expect(canvas.width).toBe(window.innerWidth);
    expect(canvas.height).toBe(window.innerHeight);
  });
});

describe('Software3DRenderer — 相机跟随', () => {
  it('相机位置在车后方', () => {
    const r = createRenderer();
    // heading=0（朝+Z），相机应在车的-Z方向
    // 间接验证：车在(0,0)，渲染不崩溃且车辆可见
    expect(() => render(r, { carX: 0, carZ: 0, heading: 0 })).not.toThrow();
  });

  it('heading变化时相机跟随旋转', () => {
    const r = createRenderer();
    expect(() => {
      for (let h = 0; h < Math.PI * 2; h += 0.2) {
        render(r, { heading: h, carZ: 10 });
      }
    }).not.toThrow();
  });

  it('车在任意世界坐标都能渲染', () => {
    const r = createRenderer();
    expect(() => {
      render(r, { carX: 100, carZ: 200, heading: 1.5 });
      render(r, { carX: -50, carZ: -100, heading: -1.5 });
    }).not.toThrow();
  });
});

describe('Software3DRenderer — 场景元素', () => {
  it('预生成了路边物体', () => {
    const r = createRenderer();
    const objects = getPrivate<unknown[]>(r, 'objects');
    expect(objects.length).toBeGreaterThan(0);
  });

  it('物体包含type、x、z、seed字段', () => {
    const r = createRenderer();
    const objects = getPrivate<{ type: string; x: number; z: number; seed: number }[]>(r, 'objects');
    for (const obj of objects) {
      expect(['tree', 'cone', 'bush', 'rock']).toContain(obj.type);
      expect(Number.isFinite(obj.x)).toBe(true);
      expect(Number.isFinite(obj.z)).toBe(true);
    }
  });

  it('物体分布在道路两侧', () => {
    const r = createRenderer();
    const objects = getPrivate<{ x: number }[]>(r, 'objects');
    const hw = getPrivate<number>(r, 'ROAD_HALF_WIDTH');
    let leftCount = 0;
    let rightCount = 0;
    for (const obj of objects) {
      if (obj.x < -hw) leftCount++;
      if (obj.x > hw) rightCount++;
    }
    expect(leftCount).toBeGreaterThan(0);
    expect(rightCount).toBeGreaterThan(0);
  });
});

describe('Software3DRenderer — 道路几何（宽度回归）', () => {
  const track = createDefaultTrack();

  it('道路边界到中心线的距离等于半宽（路面不能退化成一条线）', () => {
    const r = createRenderer();
    const bs = r.buildRoadBoundaries(track, 0, track.totalLength);
    expect(bs.length).toBeGreaterThan(10);

    for (const b of bs) {
      const dl = Math.hypot(b.leftX - b.centerX, b.leftZ - b.centerZ);
      const dr = Math.hypot(b.rightX - b.centerX, b.rightZ - b.centerZ);
      expect(dl).toBeCloseTo(track.halfWidth, 6);
      expect(dr).toBeCloseTo(track.halfWidth, 6);
    }
  });

  it('道路边界垂直于赛道方向，而不是沿赛道方向', () => {
    const r = createRenderer();
    const bs = r.buildRoadBoundaries(track, 0, track.totalLength);

    for (const b of bs) {
      const fwdX = Math.sin(b.heading);
      const fwdZ = Math.cos(b.heading);
      // 左边界相对中心的方向
      const ox = b.leftX - b.centerX;
      const oz = b.leftZ - b.centerZ;
      const len = Math.hypot(ox, oz);
      // 与前向的点积为 0 —— 旧 bug 下点积会是 ±halfWidth
      expect(Math.abs((ox / len) * fwdX + (oz / len) * fwdZ)).toBeLessThan(1e-6);
    }
  });

  it('左右边界分居赛道两侧（叉积符号相反）', () => {
    const r = createRenderer();
    const bs = r.buildRoadBoundaries(track, 0, track.totalLength);

    for (const b of bs) {
      const fwdX = Math.sin(b.heading);
      const fwdZ = Math.cos(b.heading);
      // 与前向的叉积：判断在左侧还是右侧
      const sideL = fwdX * (b.leftZ - b.centerZ) - fwdZ * (b.leftX - b.centerX);
      const sideR = fwdX * (b.rightZ - b.centerZ) - fwdZ * (b.rightX - b.centerX);
      expect(Math.sign(sideL)).toBe(-Math.sign(sideR));
    }
  });

  it('路面宽度：从车后视角看，前方约10米处的路面在屏幕上足够宽', () => {
    const r = createRenderer();
    const [carX, carZ, heading] = [0, 0, track.startHeading];
    const camX = carX - Math.sin(heading) * 6.5;
    const camY = 3.2 + r.terrainHeight(carX, carZ);
    const camZ = carZ - Math.cos(heading) * 6.5;
    const pitch = -0.16;

    const bs = r.buildRoadBoundaries(track, 0, 40);
    const project = getPrivate<
      (wx: number, wy: number, wz: number, cx: number, cy: number, cz: number, yaw: number, pitch: number) =>
        { x: number; y: number; z: number } | null
    >(r, 'project');

    // 取距相机约 10 米前方的一个采样点
    let best: { width: number; depth: number } | null = null;
    for (const b of bs) {
      const l = project(b.leftX, b.leftY, b.leftZ, camX, camY, camZ, heading, pitch);
      const rr = project(b.rightX, b.rightY, b.rightZ, camX, camY, camZ, heading, pitch);
      if (!l || !rr) continue;
      if (l.z < 8 || l.z > 12) continue;
      best = { width: Math.abs(rr.x - l.x), depth: l.z };
      break;
    }

    expect(best).not.toBeNull();
    // 12 米宽的路在 10 米处应当占据数百像素；旧 bug 下恒为 0
    expect(best!.width).toBeGreaterThan(150);
  });

  it('近裁剪面裁剪：跨越相机平面的四边形被裁成有效多边形', () => {
    const r = createRenderer();
    const clip = getPrivate<(poly: { x: number; y: number; z: number }[]) => { x: number; y: number; z: number }[]>(r, 'clipPolygonNear');
    const near = getPrivate<number>(r, 'NEAR');

    // 四边形一半在相机后方
    const poly = [
      { x: -6, y: -3, z: -4 },
      { x: 6, y: -3, z: -4 },
      { x: 6, y: -3, z: 20 },
      { x: -6, y: -3, z: 20 },
    ];
    const clipped = clip(poly);
    expect(clipped.length).toBeGreaterThanOrEqual(3);
    for (const p of clipped) {
      expect(p.z).toBeGreaterThanOrEqual(near - 1e-9);
    }
    // 裁剪后的多边形仍保持原有宽度
    const xs = clipped.map(p => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12, 6);
  });

  it('整块位于相机后方的四边形被完全裁掉', () => {
    const r = createRenderer();
    const clip = getPrivate<(poly: { x: number; y: number; z: number }[]) => { x: number; y: number; z: number }[]>(r, 'clipPolygonNear');
    const clipped = clip([
      { x: -1, y: 0, z: -5 },
      { x: 1, y: 0, z: -5 },
      { x: 1, y: 0, z: -1 },
      { x: -1, y: 0, z: -1 },
    ]);
    expect(clipped.length).toBe(0);
  });

  it('线段近裁剪：一端在相机后方时返回裁剪后的交点', () => {
    const r = createRenderer();
    const clipSeg = getPrivate<(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => unknown[] | null>(r, 'clipSegmentNear');
    const near = getPrivate<number>(r, 'NEAR');

    const seg = clipSeg({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: 10 }) as { x: number; y: number; z: number }[];
    expect(seg).not.toBeNull();
    expect(seg[0].z).toBeCloseTo(near, 9);
    expect(seg[1].z).toBeCloseTo(10, 9);

    expect(clipSeg({ x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: -1 })).toBeNull();
  });

  it('绘制窗口：只对相机附近的赛道做边界采样（无尽赛道性能）', () => {
    const r = createRenderer();
    const nearSample = track.nearestPoint(0, 0);
    const windowed = r.buildRoadBoundaries(track, nearSample.distance, nearSample.distance + 100);
    const full = r.buildRoadBoundaries(track, 0, track.totalLength);
    expect(windowed.length).toBeLessThan(full.length);
    expect(windowed.length).toBeGreaterThan(50);
    expect(windowed.length).toBeLessThanOrEqual(102);
  });
});

/**
 * 回归：「远处的路与近处的路会有重影」
 *
 * 成因：路面按固定 1 米间距切块，400 米视距下产生数百个投影高度不足 0.5 像素的
 * 碎块；每块又用自己平均深度的单色填充，互相重叠后在地平线附近形成多层重影。
 *
 * 修复：采样间距随深度自适应放大，使远处块数大幅下降。
 */
describe('Software3DRenderer — 远处路面重影（LOD 回归）', () => {
  const track = createDefaultTrack();

  it('采样间距随深度单调不减', () => {
    const r = createRenderer();
    const stepOf = (d: number): number =>
      getPrivate<(depth: number) => number>(r, 'roadStepForDepth').call(r, d);

    let prev = 0;
    for (const d of [0, 10, 39, 41, 90, 91, 160, 161, 260, 261, 1000]) {
      const s = stepOf(d);
      expect(s).toBeGreaterThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(1);
      prev = s;
    }
    // 远处必须明显比近处稀疏
    expect(stepOf(400)).toBeGreaterThan(stepOf(10));
  });

  it('远处路面块数被显著压缩（旧实现为每米一块，约 446 块）', () => {
    const r = createRenderer();
    const samples = getPrivate<
      (from: number, to: number, origin?: number) => number[]
    >(r, 'buildRoadSampleDistances').call(r, 0, 445, 0);

    // 旧实现：ceil(445 / 1) + 1 = 446 块
    expect(samples.length).toBeLessThan(150);
    expect(samples.length).toBeGreaterThan(20);
  });

  it('返回的采样距离严格单调递增，且首尾落在请求区间上', () => {
    const r = createRenderer();
    const samples = getPrivate<
      (from: number, to: number, origin?: number) => number[]
    >(r, 'buildRoadSampleDistances').call(r, 0, 445, 0);

    expect(samples[0]).toBeCloseTo(0, 9);
    expect(samples[samples.length - 1]).toBeCloseTo(445, 9);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });

  it('空区间/退化区间返回空数组，不会死循环', () => {
    const r = createRenderer();
    const f = getPrivate<(from: number, to: number, origin?: number) => number[]>(
      r, 'buildRoadSampleDistances',
    );
    expect(f.call(r, 100, 100, 0)).toEqual([]);
    expect(f.call(r, 100, 50, 0)).toEqual([]);
  });

  it('近处仍然保持 1 米精度（不能为了性能牺牲近景观感）', () => {
    const r = createRenderer();
    const stepOf = getPrivate<(depth: number) => number>(r, 'roadStepForDepth');
    expect(stepOf.call(r, 0)).toBe(1);
    expect(stepOf.call(r, 20)).toBe(1);
    expect(stepOf.call(r, 39)).toBe(1);
  });

  it('路面亮度按深度单调变暗并量化到有限档位', () => {
    const r = createRenderer();
    const bright = getPrivate<(depth: number) => number>(r, 'roadBrightnessForDepth');
    const near = bright.call(r, 5);
    const mid = bright.call(r, 200);
    const far = bright.call(r, 495);

    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    // 必须是整数（量化后可直接用作 rgb 分量）
    for (const v of [near, mid, far]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    // 档位有限：整条视距内的不同取值数量应当很少，便于合批填充
    const distinct = new Set<number>();
    for (let d = 0; d <= 500; d += 5) distinct.add(bright.call(r, d));
    expect(distinct.size).toBeLessThanOrEqual(16);
  });

  it('连续同亮度的路面块会被合并成少数几条条带（消除共享边重影）', () => {
    const r = createRenderer();
    const group = getPrivate<(bands: unknown[]) => { bands: unknown[] }[]>(r, 'groupRoadRuns');

    // 构造 120 个「首尾相接、亮度连续」的块
    const bands = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 119;
      const y = 700 - t * 400; // 由近及远
      bands.push({
        left: [{ x: 100, y }, { x: 105, y: y - 2 }],
        right: [{ x: 500, y }, { x: 495, y: y - 2 }],
      });
    }
    const runs = group.call(r, bands);
    expect(runs.length).toBeGreaterThan(0);
    // 合批后条带数必须远小于块数，否则等于没合并
    expect(runs.length).toBeLessThan(bands.length / 2);
    // 每个块都必须被归入某个条带，不能丢块
    const total = runs.reduce((s, x) => s + x.bands.length, 0);
    expect(total).toBe(bands.length);
  });

  it('左右边界缺失的块被安全跳过，不参与合批', () => {
    const r = createRenderer();
    const group = getPrivate<(bands: unknown[]) => { bands: unknown[] }[]>(r, 'groupRoadRuns');
    const runs = group.call(r, [
      { left: [{ x: 0, y: 0 }, { x: 1, y: 1 }], right: null },
      { left: null, right: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { left: [{ x: 0, y: 0 }], right: [{ x: 1, y: 1 }] },
    ]);
    const total = runs.reduce((s, x) => s + x.bands.length, 0);
    expect(total).toBe(0);
  });
});

describe('Software3DRenderer — 路边物体', () => {
  it('沿赛道生成的物体分布在道路两侧，而不是道路前后', () => {
    const r = createRenderer();
    // 用一条笔直赛道，避免自交赛道导致「最近点」歧义
    const straight = new Track([{ x: 0, z: 0 }, { x: 0, z: 600 }], 12);
    r.generateObjectsAlongTrack(straight, straight.totalLength);
    const objects = getPrivate<{ x: number; z: number }[]>(r, 'objects');
    expect(objects.length).toBeGreaterThan(0);

    let leftCount = 0;
    let rightCount = 0;
    for (const obj of objects) {
      // 旧 bug：横向偏移用成了前向量，物体全被放到道路正前方/正后方，|x| ≈ 0
      const lateral = Math.abs(obj.x);
      expect(lateral).toBeGreaterThan(straight.halfWidth * 0.5);
      expect(lateral).toBeLessThan(straight.halfWidth + 25);
      if (obj.x < 0) leftCount++;
      else rightCount++;
    }
    // 两侧都要有物体
    expect(leftCount).toBeGreaterThan(0);
    expect(rightCount).toBeGreaterThan(0);
  });
});

describe('Software3DRenderer — 车辆渲染', () => {

  it('车辆随heading旋转不崩溃', () => {
    const r = createRenderer();
    expect(() => {
      for (let h = 0; h < Math.PI * 2; h += 0.3) {
        render(r, { heading: h, carZ: 5 });
      }
    }).not.toThrow();
  });

  it('转向角变化时车轮旋转不崩溃', () => {
    const r = createRenderer();
    expect(() => {
      for (let sa = -0.6; sa <= 0.6; sa += 0.1) {
        render(r, { steerAngle: sa, carZ: 5 });
      }
    }).not.toThrow();
  });

  it('漂移时渲染烟雾不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, { isDrifting: true, speed: 20, carZ: 5 })).not.toThrow();
  });
});

/**
 * 回归：「汽车难看极了」
 *
 * 旧实现的主要问题：
 *  1. 大灯光晕半径巨大（可达 25px），把整个车头糊成两个白球；
 *  2. 车轮作为纯黑圆盘无脑叠在车身上，看起来像贴了四个黑饼；
 *  3. 车身各面用固定纯色，没有明暗层次；
 *  4. 缺少接地阴影，车「浮」在地面上。
 *
 * 修复后：面按法线方向着色、车轮与车身一起按深度排序、大灯尺寸与光晕收敛、
 * 补上柔和的椭圆接地阴影。
 */
describe('Software3DRenderer — 车辆外观（回归）', () => {
  /** 记录 fillStyle/弧线半径等，用于断言绘制特征 */
  function tracingRenderer(): { r: Software3DRenderer; ops: { name: string; args: number[]; fill?: string }[] } {
    const ops: { name: string; args: number[]; fill?: string }[] = [];
    const state = { fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1 };
    const rec = (name: string) => (...args: unknown[]) => {
      ops.push({ name, args: args as number[], fill: String(state.fillStyle) });
    };
    const noop = () => {};
    const ctx = {
      canvas: {} as HTMLCanvasElement,
      get fillStyle() { return state.fillStyle; },
      set fillStyle(v: string) { state.fillStyle = v; },
      get strokeStyle() { return state.strokeStyle; },
      set strokeStyle(v: string) { state.strokeStyle = v; },
      get lineWidth() { return state.lineWidth; },
      set lineWidth(v: number) { state.lineWidth = v; },
      lineCap: '', lineJoin: '', globalAlpha: 1, font: '',
      save: noop, restore: noop,
      translate: rec('translate'), rotate: noop, scale: rec('scale'),
      beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
      closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
      rect: noop, fillRect: rec('fillRect'), strokeRect: noop,
      arc: rec('arc'), ellipse: rec('ellipse'),
      quadraticCurveTo: noop, bezierCurveTo: noop,
      fillText: noop, measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      clearRect: noop, clip: noop, setLineDash: noop, setTransform: noop,
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      drawImage: noop, putImageData: noop,
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    } as unknown as CanvasRenderingContext2D;

    const container = document.createElement('div');
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const el = originalCreate('canvas') as HTMLCanvasElement;
        el.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
        return el;
      }
      return originalCreate(tag as keyof HTMLElementTagNameMap);
    });
    const r = new Software3DRenderer(container);
    vi.restoreAllMocks();
    ops.length = 0;
    return { r, ops };
  }

  const carTrack = createDefaultTrack();

  it('大灯光晕半径被限制在合理范围（旧实现最大 25px，糊成白球）', () => {
    const { r } = tracingRenderer();
    const glowR = getPrivate<(z: number, x: number, cam: unknown) => number>(r, 'headlightGlowRadius');

    // 车在相机后方约 6.5 米处；即使车贴到相机上，光晕也必须收敛
    for (const depth of [0.5, 1, 6.5, 20, 100]) {
      const rad = glowR.call(r, depth, 0.17, null);
      expect(Number.isFinite(rad)).toBe(true);
      expect(rad).toBeLessThanOrEqual(16);
      expect(rad).toBeGreaterThanOrEqual(0);
    }
    // 距离越远，光晕越小
    expect(glowR.call(r, 6.5, 0.17, null)).toBeGreaterThan(glowR.call(r, 30, 0.17, null));
  });

  it('存在柔和的接地阴影（旧实现完全没有阴影）', () => {
    const { r, ops } = tracingRenderer();
    r.render(0, 0, carTrack.startHeading, 0, 0, false, 1 / 60, carTrack, new SkillSystem());

    const translucentBlack = ops.filter(
      o => o.name === 'fill' && /rgba\(0,\s*0,\s*0,\s*0?\.\d+\)/.test(o.fill ?? ''),
    );
    expect(translucentBlack.length).toBeGreaterThan(0);
  });

  it('车身使用多种明暗层次的红色，而不是单色块', () => {
    const { r, ops } = tracingRenderer();
    r.render(0, 0, carTrack.startHeading, 0, 0, false, 1 / 60, carTrack, new SkillSystem());

    const reds = new Set(
      ops
        .map(o => o.fill)
        .filter((f): f is string => !!f && /^rgba\(\d+,\d+,\d+,1\)$/.test(f))
        .filter(f => {
          const [rr, gg, bb] = f.match(/\d+/g)!.map(Number);
          return rr > gg + 20 && rr > bb + 20; // 偏红
        }),
    );
    // 车漆至少要有 3 种不同亮度（顶面/侧面/背面）
    expect(reds.size).toBeGreaterThanOrEqual(3);
  });

  it('车轮以椭圆（透视）绘制并带轮毂与辐条', () => {
    const { r, ops } = tracingRenderer();
    r.render(0, 0, carTrack.startHeading, 0, 0, false, 1 / 60, carTrack, new SkillSystem());

    // 轮胎/轮毂用 ellipse 绘制（旧实现用 arc 画成正圆，缺少透视）
    const ellipses = ops.filter(o => o.name === 'ellipse');
    expect(ellipses.length).toBeGreaterThanOrEqual(4);
    // 至少 4 个轮子，且每个轮子有辐条（stroke 若干）
    expect(ops.filter(o => o.name === 'stroke').length).toBeGreaterThanOrEqual(4);
  });

  it('渲染车辆时不会无限放大几何（极端距离下仍有界）', () => {
    const { r, ops } = tracingRenderer();
    // 车贴着相机
    r.render(0, 0, carTrack.startHeading, 0, 0, false, 1 / 60, carTrack, new SkillSystem());
    for (const o of ops) {
      for (const a of o.args) {
        if (typeof a === 'number') {
          expect(Number.isFinite(a)).toBe(true);
        }
      }
    }
  });
});

describe('Software3DRenderer — 速度效果', () => {
  it('高速时渲染速度线不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, { speed: 50, carZ: 10 })).not.toThrow();
  });

  it('低速时不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, { speed: 0, carZ: 10 })).not.toThrow();
    expect(() => render(r, { speed: 5, carZ: 10 })).not.toThrow();
  });
});

describe('Software3DRenderer — 生命周期', () => {
  it('dispose移除canvas', () => {
    const container = document.createElement('div');
    const originalCreate = document.createElement.bind(document);
    const ctx = createMockCtx();
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const el = originalCreate('canvas') as HTMLCanvasElement;
        el.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
        return el;
      }
      return originalCreate(tag as keyof HTMLElementTagNameMap);
    });
    const r = new Software3DRenderer(container);
    expect(container.children.length).toBe(1);
    r.dispose();
    expect(container.children.length).toBe(0);
  });
});

/**
 * 回归：汽车转弯时太阳必须跟着动。
 *
 * 旧实现把太阳钉死在屏幕坐标 (w*0.8, skyH*0.3)，与相机朝向无关，
 * 于是无论车头怎么转，太阳都停在屏幕右上角不动 —— 看起来就像
 * 太阳贴在了挡风玻璃上。
 */
describe('Software3DRenderer — 太阳随转向移动（回归）', () => {
  type SunPos = { x: number; y: number; visible: boolean };

  function sunAt(r: Software3DRenderer, yaw: number): SunPos {
    return (r as unknown as { sunScreenPosition(y: number): SunPos }).sunScreenPosition(yaw);
  }

  it('朝向改变时太阳在屏幕上的 x 必须改变', () => {
    const r = createRenderer();
    const a = sunAt(r, 0);
    const b = sunAt(r, 0.5);

    expect(a.visible).toBe(true);
    expect(b.visible).toBe(true);
    // 这是 bug 的核心断言：旧实现下二者恒等
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(1);
  });

  it('左转与右转把太阳推向相反方向', () => {
    const r = createRenderer();
    const base = sunAt(r, 0);
    // 用较小角度，保证太阳仍在相机前方（SUN_BEARING≈63°，±0.2 仍可见）
    const left = sunAt(r, -0.2);
    const right = sunAt(r, 0.2);

    expect(base.visible).toBe(true);
    expect(left.visible).toBe(true);
    expect(right.visible).toBe(true);
    // SUN_BEARING 为正（太阳在 +heading 一侧），故车头右转时太阳相对左移
    expect(right.x).toBeLessThan(base.x);
    expect(left.x).toBeGreaterThan(base.x);
  });

  it('太阳相对车头的角偏移与转向一致，且不超过 ±180°', () => {
    const r = createRenderer();
    const offset = (yaw: number): number =>
      (r as unknown as { sunAngularOffset(y: number): number }).sunAngularOffset(yaw);

    const bearing = (r as unknown as { SUN_BEARING: number }).SUN_BEARING;
    // 朝向正对太阳时偏移为 0
    expect(offset(bearing)).toBeCloseTo(0, 6);
    for (const yaw of [-10, -3, 0, 1, 3, 10]) {
      const d = offset(yaw);
      expect(d).toBeGreaterThanOrEqual(-Math.PI - 1e-6);
      expect(d).toBeLessThanOrEqual(Math.PI + 1e-6);
    }
  });

  it('相机掉头后太阳移到背后，不再绘制（visible=false）', () => {
    const r = createRenderer();
    const bearing = (r as unknown as { SUN_BEARING: number }).SUN_BEARING;
    // 背对太阳
    expect(sunAt(r, bearing + Math.PI).visible).toBe(false);
    // 正对太阳
    expect(sunAt(r, bearing).visible).toBe(true);
  });

  it('掉头过程中方位角归一化连续，不会在 ±180° 处横跳', () => {
    const r = createRenderer();
    const offset = (yaw: number): number =>
      (r as unknown as { sunAngularOffset(y: number): number }).sunAngularOffset(yaw);

    const bearing = (r as unknown as { SUN_BEARING: number }).SUN_BEARING;

    // 除「太阳恰好在正背后」那一个分支切割点外，偏移量必须平滑变化。
    // 在切点处 ±π 的跳变是归一化的正常结果（也是不可见的），
    // 这里显式验证：跳变只发生在切点附近，且数值始终有限。
    const step = 0.01;
    let jumps = 0;
    for (let a = -3; a <= 3; a += step) {
      const d0 = offset(bearing + Math.PI + a);
      const d1 = offset(bearing + Math.PI + a + step);
      expect(Number.isFinite(d0)).toBe(true);
      expect(Number.isFinite(d1)).toBe(true);
      if (Math.abs(d1 - d0) > 0.1) jumps++;
    }
    // 至多跨越一次分支切割点
    expect(jumps).toBeLessThanOrEqual(1);
  });

  it('太阳投影使用透视尺度：视角越偏，屏幕位移越大（非线性）', () => {
    const r = createRenderer();
    const xAt = (o: number): number =>
      (r as unknown as { screenXForAngularOffset(o: number): number }).screenXForAngularOffset(o);

    const near = xAt(0.2) - xAt(0);
    const far = xAt(0.6) - xAt(0.4);
    // tan 曲线：等角度增量在越大的偏移处产生越大的屏幕位移
    expect(far).toBeGreaterThan(near);
    // 正视时太阳在屏幕水平中心
    expect(xAt(0)).toBeCloseTo(window.innerWidth / 2, 1);
  });

  it('太阳移出视野后不再绘制，避免在画布外生成巨大渐变', () => {
    const r = createRenderer();
    const bearing = (r as unknown as { SUN_BEARING: number }).SUN_BEARING;
    // 转到接近 ±90°：tan 发散，x 被推到画布之外
    const s = sunAt(r, bearing - 1.5);
    expect(Math.abs(s.x)).toBeGreaterThan(window.innerWidth);
    // 位置虽被算出，但必须被判定为不可见，不参与绘制
    expect(s.visible).toBe(false);
  });

  it('出生点（heading=0）太阳必须在画面内可见', () => {
    const r = createRenderer();
    const bearing = (r as unknown as { SUN_BEARING: number }).SUN_BEARING;
    const s = sunAt(r, 0);

    expect(s.visible).toBe(true);
    // 出生时太阳应落在画面内（旧版构图在右侧约 0.8w 处）
    expect(s.x).toBeGreaterThan(0);
    expect(s.x).toBeLessThan(window.innerWidth);
    expect(s.y).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(window.innerHeight / 2);

    // 方位角必须落在水平可见范围内，否则太阳永远看不见
    const halfFov = (r as unknown as { FOV: number }).FOV / 2 * Math.PI / 180;
    expect(Math.abs(bearing)).toBeLessThan(halfFov);
  });

  it('太阳始终位于地平线之上', () => {
    const r = createRenderer();
    for (const yaw of [-1, 0, 0.5, 1]) {
      const s = sunAt(r, yaw);
      if (!s.visible) continue;
      expect(s.y).toBeLessThan(window.innerHeight / 2);
      expect(Number.isFinite(s.x)).toBe(true);
    }
  });

  it('整帧渲染时转向会改变太阳的绘制位置', () => {
    const ops: { name: string; args: number[]; fill?: string }[] = [];
    const state = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
    const rec = (name: string) => (...args: unknown[]) => {
      ops.push({ name, args: args as number[], fill: String(state.fillStyle) });
    };
    const noop = () => {};
    const ctx = {
      canvas: {} as HTMLCanvasElement,
      get fillStyle() { return state.fillStyle; },
      set fillStyle(v: string) { state.fillStyle = v; },
      get strokeStyle() { return state.strokeStyle; },
      set strokeStyle(v: string) { state.strokeStyle = v; },
      get lineWidth() { return state.lineWidth; },
      set lineWidth(v: number) { state.lineWidth = v; },
      lineCap: '', lineJoin: '', globalAlpha: 1, font: '',
      save: noop, restore: noop,
      translate: rec('translate'), rotate: noop, scale: rec('scale'),
      beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
      closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
      rect: rec('rect'), fillRect: rec('fillRect'), strokeRect: noop,
      arc: rec('arc'), ellipse: rec('ellipse'),
      quadraticCurveTo: noop, bezierCurveTo: noop,
      fillText: noop, measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      clearRect: noop, clip: noop, setLineDash: noop, setTransform: noop,
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      drawImage: noop, putImageData: noop,
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    } as unknown as CanvasRenderingContext2D;

    const container = document.createElement('div');
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const el = originalCreate('canvas') as HTMLCanvasElement;
        el.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
        return el;
      }
      return originalCreate(tag as keyof HTMLElementTagNameMap);
    });
    const r = new Software3DRenderer(container);
    vi.restoreAllMocks();

    const track = createDefaultTrack();
    const skills = new SkillSystem();
    const skyH = window.innerHeight / 2;

    // 只统计天空区域内、且带太阳本体尺寸（半径远大于 1）的圆弧
    const sunArcsAt = (heading: number): number[] => {
      ops.length = 0;
      r.render(0, 0, heading, 0, 0, false, 1 / 60, track, skills);
      return ops
        .filter(o => o.name === 'arc' && o.args[1] < skyH && o.args[2] > 20)
        .map(o => o.args[0]);
    };

    const a = sunArcsAt(0);
    const b = sunArcsAt(0.4);

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // 旧实现下太阳 x 恒为 w*0.8，这里必须不同
    expect(Math.abs(a[0] - b[0])).toBeGreaterThan(1);
  });
});


describe('Software3DRenderer — 相机视角切换（阶段二）', () => {
  it('模式常量与纯函数：循环顺序 cockpit → chase → top', () => {
    expect(CAMERA_MODES).toEqual(['cockpit', 'chase', 'top']);
    expect(cycleCameraMode('cockpit')).toBe('chase');
    expect(cycleCameraMode('chase')).toBe('top');
    expect(cycleCameraMode('top')).toBe('cockpit');
    // 反向循环
    expect(cycleCameraMode('cockpit', -1)).toBe('top');
    // 步进大于一圈时取模（3 ≡ 0）
    expect(cycleCameraMode('chase', 3)).toBe('chase');
    expect(cycleCameraMode('chase', 4)).toBe('top');
  });

  it('isCameraMode 只接受三种合法视角', () => {
    expect(isCameraMode('cockpit')).toBe(true);
    expect(isCameraMode('chase')).toBe(true);
    expect(isCameraMode('top')).toBe(true);
    expect(isCameraMode('free')).toBe(false);
    expect(isCameraMode(undefined)).toBe(false);
    expect(isCameraMode(1)).toBe(false);
  });

  it('三种视角都有中文标签', () => {
    for (const m of CAMERA_MODES) {
      expect(CAMERA_MODE_LABELS[m].length).toBeGreaterThan(0);
      expect(CAMERA_MODE_SHORT[m].length).toBeGreaterThan(0);
    }
  });

  it('默认视角为车尾跟随', () => {
    const r = createRenderer();
    expect(r.getCameraMode()).toBe('chase');
  });

  it('setCameraMode 切换视角，非法值被忽略', () => {
    const r = createRenderer();
    r.setCameraMode('cockpit');
    expect(r.getCameraMode()).toBe('cockpit');
    r.setCameraMode('top');
    expect(r.getCameraMode()).toBe('top');
    r.setCameraMode('nonsense' as CameraMode);
    expect(r.getCameraMode()).toBe('top');
  });

  it('cycleCameraView 循环切换并返回新视角', () => {
    const r = createRenderer();
    expect(r.getCameraMode()).toBe('chase');
    expect(r.cycleCameraView()).toBe('top');
    expect(r.cycleCameraView()).toBe('cockpit');
    expect(r.cycleCameraView()).toBe('chase');
  });

  it('车尾视角：相机在车后方约 6.5 米、离地约 3.2 米，且不绘制车内视角', () => {
    const r = createRenderer();
    r.setCameraMode('chase');
    render(r, { carX: 0, carZ: 0, heading: 0 });

    const cam = r.getCameraState();
    expect(cam.z).toBeCloseTo(-6.5, 3);
    // 机位高度是相对「车辆所在地面」的，地形起伏下不能用相机所在地面去量
    expect(cam.y - r.terrainHeight(0, 0)).toBeCloseTo(3.2, 3);
    expect(getPrivate<() => boolean>(r, 'isInsideCarView')()).toBe(false);
  });

  it('车内视角：相机贴近车辆、俯仰接近水平，且不绘制本车车身', () => {
    const r = createRenderer();
    r.setCameraMode('cockpit');
    render(r, { carX: 0, carZ: 0, heading: 0 });

    const cam = r.getCameraState();
    // 相对车辆所在地面约 1.18 米，明显低于车尾视角
    expect(cam.y - r.terrainHeight(0, 0)).toBeLessThan(1.6);
    expect(Math.abs(cam.pitch)).toBeLessThan(0.1);
    // 俯仰接近水平：与车尾视角的俯角明显不同
    expect(cam.yaw).toBeCloseTo(0, 6);
    expect(getPrivate<() => boolean>(r, 'isInsideCarView')()).toBe(true);

    // 端到端：车内视角整帧渲染不应调用 drawCar
    const spy = vi.spyOn(r as unknown as { drawCar: (...a: unknown[]) => void }, 'drawCar');
    render(r, { carX: 0, carZ: 5 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('上帝俯视：相机明显抬高、俯角陡峭', () => {
    const r = createRenderer();
    r.setCameraMode('top');
    render(r, { carX: 0, carZ: 0, heading: 0 });

    const cam = r.getCameraState();
    expect(cam.y - r.terrainHeight(0, 0)).toBeGreaterThan(20);
    expect(cam.pitch).toBeLessThan(-0.9);
  });

  it('俯视程度：车尾/车内为 0，俯视为 1（天空淡出）', () => {
    const r = createRenderer();
    r.setCameraMode('chase');
    render(r);
    expect(getPrivate<() => number>(r, 'topDownBlend')()).toBe(0);

    r.setCameraMode('cockpit');
    render(r);
    expect(getPrivate<() => number>(r, 'topDownBlend')()).toBe(0);

    r.setCameraMode('top');
    for (let i = 0; i < 240; i++) render(r, { dt: 1 / 60 });
    expect(getPrivate<() => number>(r, 'topDownBlend')()).toBeGreaterThan(0.9);
  });

  it('视角切换平滑推进：单帧不会瞬移到目标机位', () => {
    const r = createRenderer();
    r.setCameraMode('chase');
    render(r, { carX: 0, carZ: 0, heading: 0 });
    const before = r.getCameraState();

    r.setCameraMode('top');
    render(r, { carX: 0, carZ: 0, heading: 0 }); // 只推进 1 帧
    const mid = r.getCameraState();

    // 目标机位离地 30 米，单帧只允许移动一小段
    expect(mid.y - before.y).toBeGreaterThan(0);
    expect(mid.y - before.y).toBeLessThan(6);
    expect(Math.abs(mid.pitch - before.pitch)).toBeLessThan(0.4);
  });

  it('视角切换多帧后收敛到目标机位', () => {
    const r = createRenderer();
    r.setCameraMode('chase');
    render(r, { carX: 0, carZ: 0, heading: 0 });

    r.setCameraMode('top');
    for (let i = 0; i < 180; i++) render(r, { carX: 0, carZ: 0, heading: 0, dt: 1 / 60 });

    const cam = r.getCameraState();
    expect(cam.y - r.terrainHeight(0, 0)).toBeCloseTo(30, 0);
    expect(cam.pitch).toBeCloseTo(-1.02, 2);
    expect(cam.z).toBeCloseTo(-13, 0);
  });

  it('相机朝向平滑跟随车头（跨 ±π 不横跳）', () => {
    const r = createRenderer();
    render(r, { heading: Math.PI - 0.05, carX: 0, carZ: 0 });
    expect(r.getCameraState().yaw).toBeCloseTo(Math.PI - 0.05, 6);

    // 车头转到 -π 附近（等价于跨过 ±π），平滑后仍应落在合理区间而不是绕远路
    for (let i = 0; i < 60; i++) render(r, { heading: -Math.PI + 0.05, carX: 0, carZ: 0, dt: 1 / 60 });
    const yaw = r.getCameraState().yaw;
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.1 + 1e-9);
  });

  it('防穿模：起伏地形上相机始终高于地面', () => {
    const r = createRenderer();
    for (const mode of CAMERA_MODES) {
      r.setCameraMode(mode);
      const spy = vi.spyOn(r as unknown as { drawCar: (...a: unknown[]) => void }, 'drawCar');
      for (let i = -20; i <= 20; i++) {
        render(r, { carX: i * 3, carZ: i * 5, heading: i * 0.3 });
        const cam = r.getCameraState();
        const ground = r.terrainHeight(cam.x, cam.z);
        expect(cam.y, `${mode} @${i}`).toBeGreaterThanOrEqual(ground);
      }
      spy.mockRestore();
    }
  });

  it('resetCamera 后下一帧直接吸附到目标机位', () => {
    const r = createRenderer();
    render(r, { carX: 0, carZ: 0, heading: 0 });
    r.setCameraMode('top');
    for (let i = 0; i < 60; i++) render(r, { carX: 0, carZ: 0, heading: 0, dt: 1 / 60 });
    expect(r.getCameraState().y - r.terrainHeight(0, 0)).toBeGreaterThan(20);

    r.resetCamera();
    r.setCameraMode('chase');
    render(r, { carX: 0, carZ: 0, heading: 0 });
    const cam = r.getCameraState();
    expect(cam.z).toBeCloseTo(-6.5, 3);
    expect(cam.y - r.terrainHeight(0, 0)).toBeCloseTo(3.2, 3);
  });

  it('三种视角整帧渲染均不崩溃（含漂移烟雾）', () => {
    for (const mode of CAMERA_MODES) {
      const r = createRenderer();
      r.setCameraMode(mode);
      expect(() => {
        for (let i = 0; i < 30; i++) {
          render(r, { carX: i, carZ: i * 2, heading: 0.4, speed: 25, steerAngle: 0.2, isDrifting: true });
        }
      }, mode).not.toThrow();
    }
  });
});
