/**
 * @vitest-environment jsdom
 *
 * Minimap 单元测试
 *
 * 重点回归「车辆箭头指向」bug：
 * 小地图把世界 (x, z) 直接映射为屏幕 (x, y)，因此 +Z 在图上朝下。
 * canvas 的 rotate() 是顺时针为正，而世界 heading 是「从 +Z 转向 +X」，
 * 两者在图上恰为同一顺时针方向，所以必须传 -heading。
 * 历史实现传了 +heading，导致箭头指向与车头方向关于地图中心镜像。
 */
import { describe, it, expect, vi } from 'vitest';
import { Minimap } from './Minimap';
import { Track } from './Track';
import { SkillSystem } from './SkillSystem';

interface Op { name: string; args: number[] }

/**
 * 造一个记录所有 canvas 调用的 mock ctx，用来验证变换与路径。
 */
function createTracingCtx(ops: Op[]): CanvasRenderingContext2D {
  const rec = (name: string) => (...args: unknown[]) => {
    ops.push({ name, args: args as number[] });
  };
  const noop = () => {};
  const grad = () => ({ addColorStop: noop });
  return {
    canvas: {} as HTMLCanvasElement,
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    globalAlpha: 1, font: '',
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    rect: rec('rect'), fillRect: rec('fillRect'), strokeRect: rec('strokeRect'),
    arc: rec('arc'), ellipse: rec('ellipse'),
    quadraticCurveTo: noop, bezierCurveTo: noop,
    fillText: rec('fillText'), measureText: () => ({ width: 0 }),
    createLinearGradient: grad, createRadialGradient: grad,
    clearRect: rec('clearRect'), clip: noop, setLineDash: rec('setLineDash'),
    setTransform: noop, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage: noop, putImageData: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  } as unknown as CanvasRenderingContext2D;
}

/** 渲染一次并返回 canvas 调用记录 */
function renderAndTrace(carX: number, carZ: number, heading: number): Op[] {
  const ops: Op[] = [];
  const ctx = createTracingCtx(ops);
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

  const map = new Minimap(container);
  const track = new Track([{ x: 0, z: 0 }, { x: 400, z: 0 }, { x: 400, z: 400 }], 12);
  map.render(track, carX, carZ, heading, new SkillSystem());
  vi.restoreAllMocks();
  return ops;
}

/** 取出「车辆箭头」那一段的变换与路径（三角形三个 moveTo/lineTo） */
function extractCarArrow(ops: Op[]): { rotate: number; pts: { x: number; y: number }[] } {
  // 车辆箭头位于最后一次 save/restore 区块内
  let lastSave = -1;
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].name === 'save') { lastSave = i; break; }
  }
  const seg = ops.slice(lastSave);
  const rotateOp = seg.find(o => o.name === 'rotate');
  const pts: { x: number; y: number }[] = [];
  for (const o of seg) {
    if (o.name === 'moveTo' || o.name === 'lineTo') pts.push({ x: o.args[0], y: o.args[1] });
  }
  return { rotate: rotateOp ? rotateOp.args[0] : 0, pts };
}

/** 把局部三角形按 rotate 变换到地图坐标，返回箭头尖端相对中心的方向 */
function arrowTipDirection(heading: number): { x: number; y: number } {
  const { rotate, pts } = extractCarArrow(renderAndTrace(0, 0, heading));
  // 三角形尖是第一个点（局部 (0, 7)）
  const tip = pts[0];
  const c = Math.cos(rotate);
  const s = Math.sin(rotate);
  const x = tip.x * c - tip.y * s;
  const y = tip.x * s + tip.y * c;
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

describe('Minimap — 车辆箭头指向（回归）', () => {
  it('heading=0（车头朝世界 +Z）时，箭头指向地图下方 (+y)', () => {
    const d = arrowTipDirection(0);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(1, 6);
  });

  it('heading=90°（车头朝世界 +X）时，箭头指向地图右侧 (+x)', () => {
    const d = arrowTipDirection(Math.PI / 2);
    expect(d.x).toBeCloseTo(1, 6);
    expect(d.y).toBeCloseTo(0, 6);
  });

  it('heading=180° 时箭头指向地图上方 (-y)', () => {
    const d = arrowTipDirection(Math.PI);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(-1, 6);
  });

  it('heading=270° 时箭头指向地图左侧 (-x)', () => {
    const d = arrowTipDirection(-Math.PI / 2);
    expect(d.x).toBeCloseTo(-1, 6);
    expect(d.y).toBeCloseTo(0, 6);
  });

  it('箭头方向始终等于世界前向量 (sin h, cos h)——旧实现为镜像 (sin h, -cos h)', () => {
    for (let h = -Math.PI; h <= Math.PI; h += Math.PI / 12) {
      const d = arrowTipDirection(h);
      // 世界前向量映射到地图坐标：世界 (x,z) -> 地图 (x,y)
      expect(d.x).toBeCloseTo(Math.sin(h), 6);
      expect(d.y).toBeCloseTo(Math.cos(h), 6);
    }
  });

  it('canvas 旋转角必须是 -heading（回归：旧代码传了 +heading）', () => {
    for (const h of [0, 0.7, Math.PI / 2, 2.4, -1.3]) {
      const { rotate } = extractCarArrow(renderAndTrace(0, 0, h));
      expect(rotate).toBeCloseTo(-h, 9);
    }
  });

  it('箭头绘制使用 save/restore 包裹，不污染后续绘制状态', () => {
    const ops = renderAndTrace(10, 20, 0.5);
    const saves = ops.filter(o => o.name === 'save').length;
    const restores = ops.filter(o => o.name === 'restore').length;
    expect(saves).toBeGreaterThan(0);
    expect(saves).toBe(restores);
  });
});
