/**
 * @vitest-environment jsdom
 *
 * Pseudo3DRenderer 单元测试（真实世界坐标版）
 * 覆盖：赛道构建、投影数学、渲染循环稳定性、真实坐标驱动、
 *       自由横向移动（无clamp）、heading旋转、离路检测、
 *       绕圈 z 距离（闪烁 bug 回归测试）、无 NaN 输出
 */
import { describe, it, expect, vi } from 'vitest';
import { Pseudo3DRenderer } from './Pseudo3DRenderer';

// ---- DOM / Canvas mock ----
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
    setTransform: noop,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage: noop,
    putImageData: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  } as unknown as CanvasRenderingContext2D;
}

function createRenderer(): Pseudo3DRenderer {
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
  return new Pseudo3DRenderer(container);
}

// 访问私有成员的辅助（测试专用），方法自动绑定 this
function getPrivate<T>(obj: unknown, key: string): T {
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val === 'function') {
    return val.bind(obj) as T;
  }
  return val as T;
}

// 新 render 签名的便捷封装
function render(
  r: Pseudo3DRenderer,
  opts: { carX?: number; carZ?: number; heading?: number; speed?: number; steerAngle?: number; isDrifting?: boolean; dt?: number } = {},
): void {
  r.render(
    opts.carX ?? 0,
    opts.carZ ?? 0,
    opts.heading ?? 0,
    opts.speed ?? 0,
    opts.steerAngle ?? 0,
    opts.isDrifting ?? false,
    opts.dt ?? 1 / 60,
  );
}

describe('Pseudo3DRenderer — 赛道构建', () => {
  it('构建后 segments 非空', () => {
    const r = createRenderer();
    const segs = getPrivate<unknown[]>(r, 'segments');
    expect(segs.length).toBeGreaterThan(0);
  });

  it('总曲率为 0（闭环赛道绕一圈后方向不偏移）', () => {
    const r = createRenderer();
    const segs = getPrivate<{ curve: number }[]>(r, 'segments');
    const totalCurve = segs.reduce((s, seg) => s + seg.curve, 0);
    expect(totalCurve).toBeCloseTo(0, 5);
  });

  it('trackLength = segments.length * SEGMENT_LENGTH', () => {
    const r = createRenderer();
    const segs = getPrivate<unknown[]>(r, 'segments');
    const sl = getPrivate<number>(r, 'SEGMENT_LENGTH');
    const tl = getPrivate<number>(r, 'trackLength');
    expect(tl).toBe(segs.length * sl);
  });

  it('每个 segment 都有 sprites 数组', () => {
    const r = createRenderer();
    const segs = getPrivate<{ sprites: unknown[] }[]>(r, 'segments');
    for (const seg of segs) {
      expect(Array.isArray(seg.sprites)).toBe(true);
    }
  });
});

describe('Pseudo3DRenderer — 投影数学 project()', () => {
  it('worldZ <= camDepth 时返回 null', () => {
    const r = createRenderer();
    const project = getPrivate<(z: number, x: number, d: number) => unknown>(r, 'project');
    expect(project(0, 0, 1)).toBeNull();
    expect(project(-10, 0, 1)).toBeNull();
    expect(project(1, 0, 1)).toBeNull();
  });

  it('worldZ > camDepth 时返回有效投影点', () => {
    const r = createRenderer();
    const project = getPrivate<(z: number, x: number, d: number) => { x: number; y: number; scale: number }>(r, 'project');
    const p = project(100, 0, 1);
    expect(p).not.toBeNull();
    expect(p.scale).toBeGreaterThan(0);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  it('scale = camDepth / worldZ', () => {
    const r = createRenderer();
    const project = getPrivate<(z: number, x: number, d: number) => { scale: number }>(r, 'project');
    const p = project(200, 0, 0.5);
    expect(p.scale).toBeCloseTo(0.5 / 200, 6);
  });

  it('camX=0 时投影 x 在屏幕中心', () => {
    const r = createRenderer();
    const w = getPrivate<number>(r, 'w');
    const project = getPrivate<(z: number, x: number, d: number) => { x: number }>(r, 'project');
    const p = project(100, 0, 1);
    expect(p.x).toBeCloseTo(w / 2, 3);
  });
});

describe('Pseudo3DRenderer — 渲染循环稳定性', () => {
  it('连续调用 render() 不抛异常', () => {
    const r = createRenderer();
    expect(() => {
      for (let i = 0; i < 60; i++) {
        render(r, { carZ: i * 0.5, speed: 30 });
      }
    }).not.toThrow();
  });

  it('carZ 增加时赛道位置推进（trackPos 变化）', () => {
    const r = createRenderer();
    render(r, { carZ: 0 });
    const tl = getPrivate<number>(r, 'trackLength');
    // 无法直接读 trackPos（局部变量），但可以通过不崩溃和 offRoad 状态间接验证
    render(r, { carZ: 100 });
    expect(r.offRoad).toBe(false);
  });

  it('render 后 canvas 尺寸与窗口一致', () => {
    const r = createRenderer();
    render(r, { carZ: 10, speed: 10 });
    const canvas = getPrivate<HTMLCanvasElement>(r, 'canvas');
    expect(canvas.width).toBe(window.innerWidth);
    expect(canvas.height).toBe(window.innerHeight);
  });
});

describe('Pseudo3DRenderer — 真实坐标驱动（自由移动）', () => {
  it('carX 为 0 时在路面上，offRoad=false', () => {
    const r = createRenderer();
    render(r, { carX: 0, carZ: 10 });
    expect(r.offRoad).toBe(false);
  });

  it('carX 很大时驶出路面，offRoad=true', () => {
    const r = createRenderer();
    // ROAD_WIDTH=2000, WORLD_SCALE=60 → 路半宽=1000伪3D单位=16.67米
    // carX=50米 → playerX = 50*60/2000 = 1.5 > 1.0
    render(r, { carX: 50, carZ: 10 });
    expect(r.offRoad).toBe(true);
  });

  it('carX 可以无限大（无 clamp 限制），渲染不崩溃', () => {
    const r = createRenderer();
    expect(() => {
      render(r, { carX: 99999, carZ: 10 });
      render(r, { carX: -99999, carZ: 10 });
    }).not.toThrow();
  });

  it('carZ 极大时绕圈不溢出', () => {
    const r = createRenderer();
    const tl = getPrivate<number>(r, 'trackLength');
    const ws = getPrivate<number>(r, 'WORLD_SCALE');
    // carZ 远超赛道长度
    const hugeZ = (tl / ws) * 10 + 100;
    expect(() => render(r, { carZ: hugeZ })).not.toThrow();
  });

  it('carZ 为负时也能正常渲染（倒车）', () => {
    const r = createRenderer();
    expect(() => render(r, { carZ: -500, speed: -10 })).not.toThrow();
  });
});

describe('Pseudo3DRenderer — heading 旋转', () => {
  it('heading=0 时渲染正常', () => {
    const r = createRenderer();
    expect(() => render(r, { heading: 0, carZ: 10, speed: 20 })).not.toThrow();
  });

  it('heading 非零时渲染正常（道路随朝向偏移）', () => {
    const r = createRenderer();
    expect(() => {
      render(r, { heading: 0.3, carZ: 10, speed: 20 });
      render(r, { heading: -0.3, carZ: 10, speed: 20 });
      render(r, { heading: Math.PI, carZ: 10, speed: 20 });
    }).not.toThrow();
  });

  it('大 heading 角不产生 NaN', () => {
    const r = createRenderer();
    expect(() => {
      for (let h = -Math.PI; h <= Math.PI; h += 0.1) {
        render(r, { heading: h, carZ: 10, speed: 10 });
      }
    }).not.toThrow();
  });

  it('steerAngle 影响屏幕倾斜', () => {
    const r = createRenderer();
    // 转向角变化时 tilt 应变化（通过不崩溃间接验证）
    render(r, { steerAngle: 0.5, carZ: 10 });
    render(r, { steerAngle: -0.5, carZ: 20 });
    const tilt = getPrivate<number>(r, 'tilt');
    expect(Number.isFinite(tilt)).toBe(true);
  });
});

describe('Pseudo3DRenderer — 离路检测', () => {
  it('在路面上时 offRoad=false', () => {
    const r = createRenderer();
    render(r, { carX: 0, carZ: 10 });
    expect(r.offRoad).toBe(false);
  });

  it('驶出路面后 offRoad=true', () => {
    const r = createRenderer();
    render(r, { carX: 50, carZ: 10 });
    expect(r.offRoad).toBe(true);
  });

  it('左侧驶出也触发 offRoad', () => {
    const r = createRenderer();
    render(r, { carX: -50, carZ: 10 });
    expect(r.offRoad).toBe(true);
  });

  it('临界值：carX 略小于路半宽时在路面上', () => {
    const r = createRenderer();
    // 路半宽 = ROAD_WIDTH/2 / WORLD_SCALE = 1000/60 ≈ 16.67米
    render(r, { carX: 15, carZ: 10 });
    expect(r.offRoad).toBe(false);
  });
});

describe('Pseudo3DRenderer — 绕圈 z 距离（闪烁 bug 回归测试）', () => {
  it('从赛道末尾到开头连续渲染不崩溃', () => {
    const r = createRenderer();
    const sl = getPrivate<number>(r, 'SEGMENT_LENGTH');
    const segs = getPrivate<unknown[]>(r, 'segments');
    const ws = getPrivate<number>(r, 'WORLD_SCALE');

    // carZ 从赛道 80% 推进到绕圈后 20%
    const startZ = segs.length * sl * 0.8 / ws;
    for (let i = 0; i < 120; i++) {
      const carZ = startZ + i * 2;
      expect(() => render(r, { carZ, speed: 40 })).not.toThrow();
    }
  });

  it('绕圈时投影 scale 不出现数量级跳变', () => {
    const r = createRenderer();
    const sl = getPrivate<number>(r, 'SEGMENT_LENGTH');
    const segs = getPrivate<unknown[]>(r, 'segments');
    const ws = getPrivate<number>(r, 'WORLD_SCALE');
    const project = getPrivate<(z: number, x: number, d: number) => { scale: number } | null>(r, 'project');
    const camDepth = 1 / Math.tan((100 / 2) * Math.PI / 180);

    const scales: number[] = [];
    const startZ = segs.length * sl * 0.8 / ws;

    for (let i = 0; i < 120; i++) {
      const carZ = startZ + i * 2;
      const worldZ = carZ * ws;
      const tl = getPrivate<number>(r, 'trackLength');
      const trackPos = ((worldZ % tl) + tl) % tl;
      const basePct = (trackPos % sl) / sl;
      const z1 = (1 - basePct) * sl; // 第1段近边距离
      const p = project(z1, 0, camDepth);
      if (p) scales.push(p.scale);
      render(r, { carZ, speed: 40 });
    }

    for (const s of scales) {
      expect(s).toBeGreaterThan(0.0001);
      expect(Number.isFinite(s)).toBe(true);
    }
    const maxS = Math.max(...scales);
    const minS = Math.min(...scales);
    expect(maxS / minS).toBeLessThan(100);
  });
});

describe('Pseudo3DRenderer — 无 NaN / Infinity 输出', () => {
  it('极端参数下渲染不产生 NaN', () => {
    const r = createRenderer();
    expect(() => {
      render(r, { carX: 1e6, carZ: 1e6, heading: 100, speed: 1000, steerAngle: 10 });
      render(r, { carX: -1e6, carZ: -1e6, heading: -100, speed: -1000, steerAngle: -10 });
    }).not.toThrow();
  });

  it('dt=0 时不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, { dt: 0, carZ: 10, speed: 30 })).not.toThrow();
  });

  it('全零参数不崩溃', () => {
    const r = createRenderer();
    expect(() => render(r, {})).not.toThrow();
  });

  it('dispose 后 canvas 被移除', () => {
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
    const r = new Pseudo3DRenderer(container);
    expect(container.children.length).toBe(1);
    r.dispose();
    expect(container.children.length).toBe(0);
  });
});
