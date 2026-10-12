/**
 * 软件3D渲染器 — 从零实现的伪3D引擎（增强版）
 * 纯 Canvas 2D，自己做 3D→2D 投影（旋转矩阵 + 透视除法）。
 * 场景：起伏地形 + 远山 + 弯道路径 + 路边物体 + 技能道具 + 精细跑车，第三人称追尾相机。
 * 车辆物理由 CarPhysics 驱动，渲染器只负责画。
 */

import type { Track } from './Track.js';
import type { SkillSystem } from './SkillSystem.js';
import { perpRight, clamp } from '../../../shared/utils/math.js';
import { CameraManager, type CameraMode } from './CameraManager.js';

// ===== 3D 数学工具 =====
interface Vec3 { x: number; y: number; z: number; }

/** 赛道左/右边界（世界坐标） */
export interface RoadBoundary {
  leftX: number; leftY: number; leftZ: number;
  rightX: number; rightY: number; rightZ: number;
  centerX: number; centerY: number; centerZ: number;
  heading: number;
  distance: number;
}

function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: v.x * c + v.z * s,
    y: v.y,
    z: -v.x * s + v.z * c,
  };
}

function rotateX(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: v.x,
    y: v.y * c - v.z * s,
    z: v.y * s + v.z * c,
  };
}

interface SceneObject {
  type: 'tree' | 'cone' | 'bush' | 'rock';
  x: number;
  z: number;
  seed: number;
}

/**
 * 一块路面在屏幕上的左右边界。
 *
 * left/right 各两点（从近到远），可以安全地与相邻块首尾拼接成连续条带。
 * 之所以不直接用四边形顶点，是因为近裁剪面裁剪后顶点个数会变化，
 * 无法保证 [左, 右, 右, 左] 的顺序。
 */
interface RoadBand {
  left: readonly { x: number; y: number }[] | null;
  right: readonly { x: number; y: number }[] | null;
}

// ========== 相机视角（阶段二）==========
// 三种视角（第一人称车内 / 车尾跟随 / 上帝俯视）的机位预设、平滑插值与防穿模
// 统一由 core/CameraManager 管理；这里转出相关常量与类型，便于 UI 与测试直接引用。
export {
  CAMERA_MODES,
  CAMERA_MODE_LABELS,
  CAMERA_MODE_SHORT,
  CAMERA_PRESETS,
  isCameraMode,
  cycleCameraMode,
} from './CameraManager.js';
export type { CameraMode, CameraState, CameraPreset } from './CameraManager.js';

export class Software3DRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // ===== 相机参数 =====
  // 机位不再写死：三种视角的参数集中在 CAMERA_PRESETS 中，见「相机视角（阶段二）」
  private readonly FOV = 72;
  private readonly NEAR = 0.1;
  private readonly FAR = 500;

  // ===== 相机管理器（阶段二）=====
  private cameraManager = new CameraManager();

  // ===== 世界参数 =====
  private readonly GRID_SIZE = 6;
  private readonly GRID_RANGE = 45;
  private readonly ROAD_HALF_WIDTH = 5.5;
  private readonly OBJECT_SPACING = 18;
  private readonly OBJECT_COUNT = 120;

  // ===== 道路绘制参数 =====
  private readonly ROAD_LIFT = 0.05;      // 路面相对地形的抬升（米）
  private readonly ROAD_STEP = 1;         // 道路近处采样间距（米）
  private readonly ROAD_BEHIND = 25;      // 相机后方绘制范围（米）
  private readonly ROAD_AHEAD = 420;      // 相机前方绘制范围（米）
  private readonly ROAD_MARK_PERIOD = 8;  // 中线虚线周期（米）

  /**
   * 远处路面的采样间距上限（米）。
   *
   * 路面是按「相邻采样点组成的四边形」逐块填充的，每块用自己平均深度算出的
   * 单色雾化亮度。原先全程使用 1 米固定间距，在 400 米视距下会产生数百个
   * 投影高度不足 0.5 像素的碎块，它们互相重叠、亮度又各不相同，
   * 于是地平线附近出现「同一条路画出好几层」的重影/摩尔纹。
   *
   * 改为按深度自适应：越远采样越稀，保证每块的投影高度大致不低于
   * MIN_ROAD_SEG_PX 像素，块数下降到几十个，重影随之消失。
   */
  private readonly MIN_ROAD_SEG_PX = 3;

  /** 路面近处亮度（无雾） */
  private readonly ROAD_BRIGHT_NEAR = 60;
  /** 路面远处亮度（完全雾化） */
  private readonly ROAD_BRIGHT_FAR = 35;
  /** 路面亮度量化档数：越大越平滑，越小越容易合并成连续条带 */
  private readonly ROAD_BRIGHT_BANDS = 12;

  // ===== 天空/太阳参数 =====
  /**
   * 太阳在世界中的方位角（弧度），固定不动。
   *
   * 约定与车辆 heading 一致：0 朝 +Z，顺时针增大。
   * 太阳是「无限远」的光源，其方向不随相机改变——转弯时它必须相对
   * 车头发生位移，这正是旧实现缺失的部分。
   *
   * 取值让太阳在出生点（heading=0）位于画面右上（约 0.8w，与旧版构图一致）。
   * 注意必须明显小于半个 FOV（36°），否则太阳一出生就在画面之外：
   * 水平可见范围只有 ±36°，把方位角开到 60° 以上会让它永远看不见。
   */
  readonly SUN_BEARING = 0.41;
  /** 太阳相对地平线的仰角（弧度），为正值表示在地平线之上 */
  readonly SUN_ELEVATION = 0.34;
  /** 太阳本体（不含光晕）的角半径，用于换算屏幕像素半径 */
  private readonly SUN_ANGULAR_RADIUS = 0.026;

  /** 道路采样间距随深度递增的档位（米），必须单调不减 */
  private readonly ROAD_STEP_STOPS: readonly { depth: number; step: number }[] = [
    { depth: 40, step: 1 },
    { depth: 90, step: 2 },
    { depth: 160, step: 4 },
    { depth: 260, step: 8 },
    { depth: Infinity, step: 16 },
  ];

  private w = 0;
  private h = 0;
  private focal = 0;

  private objects: SceneObject[] = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;position:absolute;top:0;left:0;';
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    container.appendChild(this.canvas);
    this.generateObjects();
    window.addEventListener('resize', this.resize);
  }

  private resize = (): void => {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.focal = (this.h / 2) / Math.tan((this.FOV / 2) * Math.PI / 180);
  };

  /**
   * 地形高度函数 — 起伏的丘陵（公开，供物理引擎计算坡度重力）
   */
  terrainHeight(x: number, z: number): number {
    return (
      Math.sin(x * 0.04) * 2.5 +
      Math.sin(z * 0.03 + 1) * 3.5 +
      Math.sin((x + z) * 0.02) * 2 +
      Math.sin(x * 0.08 - z * 0.06) * 1
    );
  }

  // ========== 相机模式（阶段二）==========

  /** 切换相机视角（非法值被忽略） */
  setCameraMode(mode: CameraMode): void {
    this.cameraManager.setMode(mode);
  }

  /** 当前相机视角 */
  getCameraMode(): CameraMode {
    return this.cameraManager.getMode();
  }

  /** 循环切换相机视角（快捷键用），返回切换后的视角 */
  cycleCameraView(step: number = 1): CameraMode {
    return this.cameraManager.cycle(step);
  }

  /** 当前平滑后的相机状态（调试面板 / 测试用） */
  getCameraState(): { mode: CameraMode; x: number; y: number; z: number; yaw: number; pitch: number } {
    return this.cameraManager.getState();
  }

  /** 相机管理器（调试 / 测试可直接访问其预设与过渡量） */
  getCameraManager(): CameraManager {
    return this.cameraManager;
  }

  /** 复位相机平滑状态，下一帧直接吸附到目标机位 */
  resetCamera(): void {
    this.cameraManager.reset();
  }

  /** 俯视程度 [0,1]：由相机管理器给出，用于天空/地面过渡 */
  private topDownBlend(): number {
    return this.cameraManager.topDownBlend();
  }

  /** 是否处于车内视角（相机贴近座舱，此时不绘制本车车身，避免糊住画面） */
  private isInsideCarView(): boolean {
    return this.cameraManager.isInsideCar((x, z) => this.terrainHeight(x, z));
  }

  /**
   * 获取路边物体列表（供碰撞检测使用）
   */
  getObjects(): SceneObject[] {
    return this.objects;
  }

  private generateObjects(): void {
    // 默认生成：在大范围随机散布（无赛道时用）
    this.objects = [];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < this.OBJECT_COUNT * 2; i++) {
      const x = (rand() - 0.5) * 500;
      const z = (rand() - 0.5) * 500;
      const r = rand();
      const type: SceneObject['type'] = r < 0.4 ? 'tree' : r < 0.65 ? 'bush' : r < 0.85 ? 'rock' : 'cone';
      this.objects.push({ type, x, z, seed: Math.floor(rand() * 1000) });
    }
  }

  /**
   * 沿赛道两侧生成物体（设置赛道后调用）
   */
  generateObjectsAlongTrack(track: { sampleAtDistance: (d: number) => { x: number; z: number; heading: number } }, totalLength: number): void {
    this.objects = [];
    this.appendObjectsAlongTrack(track, 0, totalLength);
  }

  /**
   * 在赛道指定距离范围内增量生成物体（无尽生成用）
   */
  appendObjectsAlongTrack(
    track: { sampleAtDistance: (d: number) => { x: number; z: number; heading: number } },
    startDist: number,
    endDist: number,
  ): void {
    let seed = Math.floor(startDist * 1000) + 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const segmentLen = endDist - startDist;
    const count = Math.max(2, Math.floor(segmentLen / 25)); // 每25米一组物体
    const spacing = segmentLen / count;

    for (let i = 0; i < count; i++) {
      const d = startDist + i * spacing + rand() * spacing * 0.5;
      const pt = track.sampleAtDistance(Math.min(d, endDist - 1));
      // 垂直于赛道方向，才能把物体放到「路边」而不是「路前方/后方」
      const perpX = perpRight(pt.heading).x;
      const perpZ = perpRight(pt.heading).z;

      for (const side of [-1, 1]) {
        const r = rand();
        const type: SceneObject['type'] = r < 0.45 ? 'tree' : r < 0.7 ? 'bush' : r < 0.9 ? 'rock' : 'cone';
        const dist = 8 + rand() * 20;
        this.objects.push({
          type,
          x: pt.x + perpX * side * dist + (rand() - 0.5) * 4,
          z: pt.z + perpZ * side * dist + (rand() - 0.5) * 4,
          seed: Math.floor(rand() * 1000),
        });
      }
    }
  }

  /**
   * 世界坐标 → 相机空间坐标（yaw 旋转 → pitch 旋转，不做透视除法）
   */
  private toCameraSpace(
    worldX: number, worldY: number, worldZ: number,
    camX: number, camY: number, camZ: number,
    yaw: number, pitch: number,
  ): Vec3 {
    let v: Vec3 = { x: worldX - camX, y: worldY - camY, z: worldZ - camZ };
    v = rotateY(v, -yaw);
    v = rotateX(v, pitch);
    return v;
  }

  /**
   * 相机空间坐标 → 屏幕坐标（透视除法 + 近/远裁剪）
   */
  private projectCameraSpace(v: Vec3): { x: number; y: number; z: number } | null {
    if (v.z <= this.NEAR) return null;
    if (v.z > this.FAR) return null;
    return {
      x: this.w / 2 + (v.x / v.z) * this.focal,
      y: this.h / 2 - (v.y / v.z) * this.focal,
      z: v.z,
    };
  }

  private project(
    worldX: number, worldY: number, worldZ: number,
    camX: number, camY: number, camZ: number,
    yaw: number, pitch: number,
  ): { x: number; y: number; z: number } | null {
    return this.projectCameraSpace(
      this.toCameraSpace(worldX, worldY, worldZ, camX, camY, camZ, yaw, pitch),
    );
  }

  /**
   * Sutherland–Hodgman：把相机空间多边形裁剪到近裁剪面之内。
   *
   * 不裁剪直接丢弃近裁剪面之后的顶点会让四边形塌陷成三角形，
   * 于是路面的可见宽度会随视角跳变——这正是「同一条路不同角度看宽窄不同」的成因之一。
   */
  private clipPolygonNear(poly: Vec3[]): Vec3[] {
    const near = this.NEAR;
    const out: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const aIn = a.z >= near;
      const bIn = b.z >= near;
      if (aIn) out.push(a);
      if (aIn !== bIn) {
        const t = (near - a.z) / (b.z - a.z);
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: near,
        });
      }
    }
    return out;
  }

  /**
   * 把一条相机空间线段裁剪到近裁剪面之内（两端都在后方时返回 null）
   */
  private clipSegmentNear(a: Vec3, b: Vec3): [Vec3, Vec3] | null {
    const near = this.NEAR;
    const aIn = a.z >= near;
    const bIn = b.z >= near;
    if (aIn && bIn) return [a, b];
    if (!aIn && !bIn) return null;
    const t = (near - a.z) / (b.z - a.z);
    const p: Vec3 = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: near,
    };
    return aIn ? [a, p] : [p, b];
  }

  /**
   * 绘制一批已裁剪到近裁剪面的线段。
   *
   * 与 strokeCameraSegments 的区别：调用方已经裁剪过（用的是与路面完全相同的
   * 裁剪结果），这里只投影，保证路面与边线严格对齐，不再出现「路面和白线
   * 各画各的」所导致的重影。
   */
  private strokeClippedSegments(
    segs: readonly (readonly [Vec3, Vec3] | null)[],
    style: string,
    lineWidth: number,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drew = false;
    for (const seg of segs) {
      if (!seg) continue;
      const a = this.projectCameraSpace(seg[0]);
      const b = this.projectCameraSpace(seg[1]);
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      drew = true;
    }
    if (drew) ctx.stroke();
  }

  /**
   * 路面亮度：按深度做雾化，并量化到有限档位。
   *
   * 量化让相邻路面块更容易落进同一档，从而可以被合并成少数几条连续路径
   * （见 fillRoadBands）。档位足够密，肉眼不会看出台阶。
   */
  roadBrightnessForDepth(depth: number): number {
    const fog = Math.max(0, 1 - depth / this.FAR);
    const bright = this.ROAD_BRIGHT_NEAR * fog + this.ROAD_BRIGHT_FAR * (1 - fog);
    const bands = this.ROAD_BRIGHT_BANDS;
    const span = Math.max(1, this.ROAD_BRIGHT_NEAR - this.ROAD_BRIGHT_FAR);
    const q = Math.round(((bright - this.ROAD_BRIGHT_FAR) / span) * bands) / bands;
    const value = this.ROAD_BRIGHT_FAR + q * span;
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  /**
   * 填充路面。
   *
   * 输入是每个路面块的左右边界点（已投影到屏幕）。
   * 相邻块共享一条边，若逐块 closePath()+fill()，共享边会被抗锯齿混合两次；
   * 在远处每块不足 1 像素时，这种双重混合会累积成明显的接缝/重影。
   *
   * 因此把「亮度档位相同且首尾相接」的块拼成一条闭合带，每串只 fill 一次。
   * 条带内部没有共享边，接缝即被消除。
   */
  private fillRoadBands(bands: readonly RoadBand[]): void {
    const ctx = this.ctx;
    if (bands.length === 0) return;

    const runs = this.groupRoadRuns(bands);
    for (const run of runs) {
      const bright = run.brightness;
      ctx.fillStyle = `rgb(${bright},${bright},${bright + 5})`;
      ctx.beginPath();

      // 在「同一条路径」里逐个加入四边形，最后只 fill 一次。
      //
      // 关键点：
      //  - 每块单独 moveTo，块与块之间不连线，因此不会因为
      //    「屏幕 y 越过地平线后顺序翻转」而画出蝴蝶结/条纹；
      //  - 但整条带子共用一次 fill()，共享边只被光栅化一次，
      //    远处每块不足 1 像素时的双重抗锯齿接缝随之消失。
      //    这正是消除「远近距离路面重影」的核心。
      let added = 0;
      for (const b of run.bands) {
        if (!b.left || !b.right || b.left.length < 2 || b.right.length < 2) continue;
        const l0 = b.left[0];
        const l1 = b.left[1];
        const r0 = b.right[0];
        const r1 = b.right[1];
        ctx.moveTo(l0.x, l0.y);
        ctx.lineTo(l1.x, l1.y);
        ctx.lineTo(r1.x, r1.y);
        ctx.lineTo(r0.x, r0.y);
        ctx.closePath();
        added++;
      }
      if (added > 0) ctx.fill();
    }
  }

  /**
   * 把按远→近排序的路面块，按「亮度档位 + 相邻性」切成若干连续条带。
   */
  groupRoadRuns(
    bands: readonly RoadBand[],
  ): { brightness: number; bands: RoadBand[] }[] {
    const runs: { brightness: number; bands: RoadBand[] }[] = [];
    if (bands.length === 0) return runs;

    const horizon = this.h / 2;
    const depthFromY = (avgY: number): number => {
      const t = Math.max(0, Math.min(1, (avgY - horizon) / Math.max(1, this.h - horizon)));
      return this.FAR * (1 - t);
    };
    const midY = (b: RoadBand): number => {
      const pts = [...(b.left ?? []), ...(b.right ?? [])];
      if (pts.length === 0) return this.h;
      return pts.reduce((s, p) => s + p.y, 0) / pts.length;
    };

    let current: RoadBand[] = [];
    let currentBright = -1;
    let prevY = NaN;

    const flush = (): void => {
      if (current.length > 0) runs.push({ brightness: currentBright, bands: current });
      current = [];
      currentBright = -1;
      prevY = NaN;
    };

    // 只有出现真正的屏幕空间跳跃（例如赛道的另一段绕回画面）才断开
    const jumpTol = Math.max(this.h * 0.12, 40);

    for (const b of bands) {
      if (!b.left || !b.right || b.left.length < 2 || b.right.length < 2) continue;
      const y = midY(b);
      const bright = this.roadBrightnessForDepth(depthFromY(y));
      const jump = Number.isFinite(prevY) && Math.abs(y - prevY) > jumpTol;
      if (current.length > 0 && (bright !== currentBright || jump)) flush();
      if (current.length === 0) currentBright = bright;
      current.push(b);
      prevY = y;
    }
    flush();
    return runs;
  }
  private strokeCameraSegments(pts: Vec3[], style: string, lineWidth: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = this.clipSegmentNear(pts[i], pts[i + 1]);
      if (!seg) continue;
      const a = this.projectCameraSpace(seg[0]);
      const b = this.projectCameraSpace(seg[1]);
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  render(
    carX: number, carZ: number, heading: number,
    speed: number, steerAngle: number, isDrifting: boolean, dt: number,
    track: Track, skillSystem: SkillSystem,
    driftIntensity: number = 0, slipAngle: number = 0,
  ): void {
    const ctx = this.ctx;

    // 相机：由相机管理器统一求解（视角模式 + 平滑插值 + 防穿模）
    const cam = this.cameraManager.update(carX, carZ, heading, dt, (x, z) => this.terrainHeight(x, z));
    const camX = cam.x;
    const camY = cam.y;
    const camZ = cam.z;
    const yaw = cam.yaw;
    const pitch = cam.pitch;

    // ===== 天空 + 太阳（太阳按世界方位投影，随车头转向移动）=====
    const skyH = this.h * 0.5;
    this.drawSky(yaw);

    // ===== 远山（2D剪影，分层）=====
    this.drawMountains(skyH, camX, camZ);

    // ===== 地面（基础填充）=====
    const ground = ctx.createLinearGradient(0, skyH, 0, this.h);
    ground.addColorStop(0, '#689f38');
    ground.addColorStop(0.4, '#558b2f');
    ground.addColorStop(1, '#33691e');
    ctx.fillStyle = ground;
    ctx.fillRect(0, skyH, this.w, this.h - skyH);

    // ===== 俯视视角：天空/远山淡出，整屏铺满地面（避免俯视时露出天空色块）=====
    const topBlend = this.topDownBlend();
    if (topBlend > 0) {
      const fullGround = ctx.createLinearGradient(0, 0, 0, this.h);
      fullGround.addColorStop(0, '#689f38');
      fullGround.addColorStop(0.55, '#558b2f');
      fullGround.addColorStop(1, '#33691e');
      ctx.globalAlpha = topBlend;
      ctx.fillStyle = fullGround;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }

    // ===== 地形网格（带高度）=====
    this.drawTerrain(camX, camY, camZ, yaw, pitch);

    // ===== 道路（沿赛道弯曲路径）=====
    this.drawTrackRoad(track, camX, camY, camZ, yaw, pitch);

    // ===== 起点/终点标记 =====
    this.drawStartEnd(track, camX, camY, camZ, yaw, pitch);

    // ===== 技能道具 =====
    for (const item of skillSystem.items) {
      if (item.collected) continue;
      this.drawSkillItem(item, camX, camY, camZ, yaw, pitch);
    }

    // ===== 路边物体 =====
    const visibleObjects: { obj: SceneObject; depth: number }[] = [];
    for (const obj of this.objects) {
      const relX = obj.x - camX;
      const relZ = obj.z - camZ;
      const rotated = rotateY({ x: relX, y: 0, z: relZ }, -yaw);
      if (rotated.z > this.NEAR && rotated.z < this.FAR) {
        visibleObjects.push({ obj, depth: rotated.z });
      }
    }
    visibleObjects.sort((a, b) => b.depth - a.depth);
    for (const { obj } of visibleObjects) {
      this.drawObject(obj, camX, camY, camZ, yaw, pitch);
    }

    // ===== 车辆 =====
    // 车内视角不画本车车身（相机就在座舱里，画出来会糊住整个画面）
    if (!this.isInsideCarView()) {
      this.drawCar(carX, carZ, heading, camX, camY, camZ, yaw, pitch, steerAngle);
    }

    // ===== 速度线 =====
    const speedNorm = Math.min(Math.abs(speed) / 50, 1);
    if (speedNorm > 0.35) {
      const alpha = (speedNorm - 0.35) * 0.3;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1.5;
      const cx = this.w / 2;
      const cy = this.h * 0.45;
      for (let i = 0; i < 18; i++) {
        const angle = (i / 18) * Math.PI * 2 + speed * 0.008;
        const r1 = Math.min(this.w, this.h) * 0.28;
        const r2 = r1 + speedNorm * 100;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
        ctx.stroke();
      }
    }

    // ===== 漂移烟雾 =====
    // 烟雾规模与透明度随漂移强度增长，并朝侧滑外侧拖尾，让漂移更有分量
    if (isDrifting && Math.abs(speed) > 5) {
      const intensity = clamp(driftIntensity > 0 ? driftIntensity : 0.35, 0.15, 1);
      const count = 4 + Math.round(intensity * 8);
      const trail = Math.sign(slipAngle) * intensity * 90;
      ctx.fillStyle = `rgba(180,180,180,${(0.12 + 0.22 * intensity).toFixed(3)})`;
      for (let i = 0; i < count; i++) {
        const sx = this.w / 2 + trail + (Math.random() - 0.5) * 140;
        const sy = this.h * 0.7 + Math.random() * 50;
        ctx.beginPath();
        ctx.arc(sx, sy, 8 + Math.random() * (18 + 22 * intensity), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * 太阳相对相机「正前方」的角偏移（弧度），正值表示偏右。
   *
   * 太阳方位固定在世界中，相机朝 heading，因此偏移量只取决于二者之差。
   * 结果归一化到 [-PI, PI]，相机掉头时太阳会连续地从一侧滑到另一侧，
   * 而不是在 ±PI 处突然横跳。
   */
  sunAngularOffset(yaw: number): number {
    let d = this.SUN_BEARING - yaw;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /**
   * 把「相对相机的角偏移」换算成屏幕 x 坐标。
   *
   * 直接用 focal * tan(角度) 相当于一次透视投影，与场景中其它物体
   * （道路、树木）走的是同一套投影逻辑，因此太阳与它们始终对得上。
   * 不用 x=w/2+focal*角度 这类小角度近似——那在视角接近 90° 时
   * 会把太阳推到画布外极远的位置。
   */
  screenXForAngularOffset(offset: number): number {
    const tanFovHalf = Math.tan((this.FOV / 2) * Math.PI / 180);
    return this.w / 2 + (Math.tan(offset) / tanFovHalf) * (this.w / 2);
  }

  /**
   * 太阳中心的屏幕坐标。
   *
   * 返回 null 表示太阳已转到相机背后（|偏移| ≥ 90°），此时不应绘制。
   * 这是修复「汽车转弯太阳不动」的核心：太阳位置由相机朝向推导，
   * 转弯时它会随视角一起移动。
   */
  sunScreenPosition(yaw: number): { x: number; y: number; visible: boolean } {
    const offset = this.sunAngularOffset(yaw);
    const horizon = this.h / 2;
    const y = horizon - Math.tan(this.SUN_ELEVATION) * this.focal;
    const x = this.screenXForAngularOffset(offset);

    // 可见性判据：
    //  - 太阳必须在相机前方（|偏移| < 90°），否则它在身后，不该出现；
    //  - 且投影结果要落在画布附近。视角接近 90° 时 tan 发散，x 会被推到
    //    数千像素之外，画它只是白白浪费一次巨大的径向渐变填充。
    const ahead = Math.abs(offset) < Math.PI / 2;
    const onCanvas = x > -this.w && x < this.w * 2;
    return { x, y, visible: ahead && onCanvas };
  }

  /**
   * 画天空渐变与太阳。
   *
   * 太阳按世界方位投影到屏幕上，转弯/掉头时相对车头移动；
   * 光晕与本体都随太阳一起走，并被限制在天空区域内，
   * 避免太阳降到地平线以下时在草地/路面上留下亮斑。
   */
  private drawSky(yaw: number): void {
    const ctx = this.ctx;
    const skyH = this.h * 0.5;

    const sky = ctx.createLinearGradient(0, 0, 0, skyH);
    sky.addColorStop(0, '#1565c0');
    sky.addColorStop(0.4, '#42a5f5');
    sky.addColorStop(0.8, '#90caf9');
    sky.addColorStop(1, '#e3f2fd');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, skyH);

    const sun = this.sunScreenPosition(yaw);
    if (!sun.visible) return;

    // 光晕/本体半径按角直径换算，远处看起来尺寸恒定，不随分辨率跳变
    const tanFovHalf = Math.tan((this.FOV / 2) * Math.PI / 180);
    const unit = this.w / 2 / tanFovHalf;
    const coreR = Math.max(this.SUN_ANGULAR_RADIUS * unit, 4);
    const glowR = coreR * 3.6;

    // 只画在天空区域内，太阳落到地平线下就不会污染地面
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.w, skyH);
    ctx.clip();

    const sunGlow = ctx.createRadialGradient(sun.x, sun.y, coreR * 0.2, sun.x, sun.y, glowR);
    sunGlow.addColorStop(0, 'rgba(255,245,157,0.9)');
    sunGlow.addColorStop(0.4, 'rgba(255,235,59,0.4)');
    sunGlow.addColorStop(1, 'rgba(255,235,59,0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff9c4';
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, coreR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * 画远山剪影（三层，视差滚动）
   */
  private drawMountains(skyH: number, camX: number, camZ: number): void {
    const ctx = this.ctx;
    const layers = [
      { color: '#7cb342', offset: 0.003, amp: 35, base: skyH - 5 },
      { color: '#558b2f', offset: 0.006, amp: 25, base: skyH - 2 },
      { color: '#33691e', offset: 0.01, amp: 18, base: skyH },
    ];
    for (const layer of layers) {
      ctx.fillStyle = layer.color;
      ctx.beginPath();
      ctx.moveTo(0, layer.base);
      for (let x = 0; x <= this.w; x += 8) {
        const hh = (
          Math.sin(x * 0.005 + camX * layer.offset + camZ * layer.offset * 0.5) * layer.amp +
          Math.sin(x * 0.012 + camZ * layer.offset) * layer.amp * 0.5 +
          layer.amp * 0.5
        );
        ctx.lineTo(x, layer.base - hh);
      }
      ctx.lineTo(this.w, layer.base);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * 画起伏地形
   */
  private drawTerrain(
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
  ): void {
    const ctx = this.ctx;
    const gs = this.GRID_SIZE;
    const range = this.GRID_RANGE;
    const baseGX = Math.floor(camX / gs);
    const baseGZ = Math.floor(camZ / gs);

    interface Quad {
      pts: ({ x: number; y: number } | null)[];
      depth: number;
      color: string;
    }
    const quads: Quad[] = [];

    for (let gx = -range; gx <= range; gx++) {
      for (let gz = -range; gz <= range; gz++) {
        const wx = (baseGX + gx) * gs;
        const wz = (baseGZ + gz) * gs;

        const y00 = this.terrainHeight(wx, wz);
        const y10 = this.terrainHeight(wx + gs, wz);
        const y11 = this.terrainHeight(wx + gs, wz + gs);
        const y01 = this.terrainHeight(wx, wz + gs);

        const corners = [
          this.project(wx, y00, wz, camX, camY, camZ, yaw, pitch),
          this.project(wx + gs, y10, wz, camX, camY, camZ, yaw, pitch),
          this.project(wx + gs, y11, wz + gs, camX, camY, camZ, yaw, pitch),
          this.project(wx, y01, wz + gs, camX, camY, camZ, yaw, pitch),
        ];

        const visible = corners.filter(c => c !== null);
        if (visible.length < 3) continue;

        const isLight = ((baseGX + gx) + (baseGZ + gz)) % 2 === 0;
        const avgDepth = visible.reduce((s, c) => s + c!.z, 0) / visible.length;
        const avgHeight = (y00 + y10 + y11 + y01) / 4;

        const fog = Math.max(0, 1 - avgDepth / this.FAR);
        // 高度影响颜色：高的更亮（草少石多），低的更深（草密）
        const heightFactor = Math.max(0, Math.min(1, (avgHeight + 5) / 12));
        const baseBright = isLight ? 85 : 60;
        const r = Math.floor((baseBright + heightFactor * 20) * fog + 25 * (1 - fog));
        const g = Math.floor((baseBright * 1.35 + heightFactor * 10) * fog + 30 * (1 - fog));
        const b = Math.floor(baseBright * 0.45 * fog + 20 * (1 - fog));

        quads.push({ pts: corners, depth: avgDepth, color: `rgb(${r},${g},${b})` });
      }
    }

    quads.sort((a, b) => b.depth - a.depth);
    for (const q of quads) {
      const pts = q.pts.filter(p => p !== null) as { x: number; y: number }[];
      if (pts.length < 3) continue;
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * 按「相机前方深度」选择道路采样间距（米）。
   *
   * 分档而不是连续取整，是为了让间距在同一档内保持恒定——
   * 否则采样点会随相机移动而前后滑动，路面亮度条纹会跟着抖动。
   */
  roadStepForDepth(depth: number): number {
    for (const s of this.ROAD_STEP_STOPS) {
      if (depth <= s.depth) return Math.max(this.ROAD_STEP, s.step);
    }
    return this.ROAD_STEP;
  }

  /**
   * 按深度自适应的间距，在 [fromDistance, toDistance] 上生成采样距离列表。
   *
   * 近处细、远处粗：既保留近景路面的平滑边缘，又把远处碎块数量压下来，
   * 消除地平线附近的重影。返回的距离严格单调递增，且包含区间两端。
   *
   * @param fromDistance 起始里程（米）
   * @param toDistance   结束里程（米）
   * @param depthOrigin  该里程对应的「相机前方深度」（米），用于选档。
   *                     通常取 nearSample.distance，使档位随相机位置滚动，
   *                     避免路面亮度条纹钉死在赛道上。
   */
  buildRoadSampleDistances(fromDistance: number, toDistance: number, depthOrigin: number = fromDistance): number[] {
    const span = toDistance - fromDistance;
    const out: number[] = [];
    if (!(span > 0)) return out;

    let d = fromDistance;
    out.push(d);
    let guard = 0;
    // 上限防止极端参数下死循环
    while (d < toDistance && guard++ < 100000) {
      const depth = Math.max(0, d - depthOrigin);
      const step = this.roadStepForDepth(depth);
      d = Math.min(d + step, toDistance);
      out.push(d);
    }
    return out;
  }

  /**
   * 预计算赛道 [fromDistance, toDistance] 区间内的左右边界（世界坐标）。
   *
   * 横向偏移必须沿垂直于赛道朝向的方向（perpRight），
   * 并且左右边缘各自贴合地形高度，路面才是一条等宽的带子。
   * 该方法是公开可测的：测试会断言 |left-center| == halfWidth 且垂直于赛道方向。
   *
   * 采样间距按深度自适应（见 ROAD_STEP_STOPS），以消除远处路面的重影。
   */
  buildRoadBoundaries(track: Track, fromDistance: number, toDistance: number, depthOrigin?: number): RoadBoundary[] {
    const hw = track.halfWidth;
    const out: RoadBoundary[] = [];
    const distances = this.buildRoadSampleDistances(fromDistance, toDistance, depthOrigin ?? fromDistance);
    if (distances.length < 2) return out;

    for (const d of distances) {
      const pt = track.sampleAtDistance(d);
      const perp = perpRight(pt.heading);

      // 左边缘 = 中心 - 右向量 * 半宽；右边缘 = 中心 + 右向量 * 半宽
      const leftX = pt.x - perp.x * hw;
      const leftZ = pt.z - perp.z * hw;
      const rightX = pt.x + perp.x * hw;
      const rightZ = pt.z + perp.z * hw;

      out.push({
        leftX, leftZ, leftY: this.terrainHeight(leftX, leftZ) + this.ROAD_LIFT,
        rightX, rightZ, rightY: this.terrainHeight(rightX, rightZ) + this.ROAD_LIFT,
        centerX: pt.x, centerY: this.terrainHeight(pt.x, pt.z) + this.ROAD_LIFT, centerZ: pt.z,
        heading: pt.heading,
        distance: d,
      });
    }
    return out;
  }

  /**
   * 画赛道道路（沿弯曲路径，等宽带状）
   */
  private drawTrackRoad(
    track: Track,
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
  ): void {
    const ctx = this.ctx;

    // 只绘制相机附近的道路窗口：无尽赛道可能有上千米，全量绘制纯属浪费
    const nearSample = track.nearestPoint(camX, camZ);
    let d0 = nearSample.distance - this.ROAD_BEHIND;
    let d1 = nearSample.distance + this.ROAD_AHEAD;
    if (!track.cyclic) {
      d0 = Math.max(0, d0);
      d1 = Math.min(track.totalLength, d1);
    }
    if (d1 - d0 < this.ROAD_STEP) return;

    // depthOrigin 让采样档位随相机滚动，条纹不会钉死在赛道上
    const boundaries = this.buildRoadBoundaries(track, d0, d1, nearSample.distance);

    // 第二步：世界坐标 → 相机空间（投影前的裁剪在相机空间进行）
    const camPts = boundaries.map(b => ({
      left: this.toCameraSpace(b.leftX, b.leftY, b.leftZ, camX, camY, camZ, yaw, pitch),
      right: this.toCameraSpace(b.rightX, b.rightY, b.rightZ, camX, camY, camZ, yaw, pitch),
      center: this.toCameraSpace(b.centerX, b.centerY, b.centerZ, camX, camY, camZ, yaw, pitch),
      distance: b.distance,
    }));

    // 第三步：相邻采样点组成四边形，近裁剪后再投影
    interface RoadSeg {
      pts: { x: number; y: number }[];
      depth: number;
      /** 该块投影后的左边界两点（从近到远），用于拼接连续条带 */
      left: [{ x: number; y: number }, { x: number; y: number }] | null;
      /** 该块投影后的右边界两点（从近到远） */
      right: [{ x: number; y: number }, { x: number; y: number }] | null;
      /** 左右边线裁剪后的相机空间端点 */
      leftSeg: [Vec3, Vec3] | null;
      rightSeg: [Vec3, Vec3] | null;
    }
    const segs: RoadSeg[] = [];

    for (let i = 0; i < camPts.length - 1; i++) {
      const a = camPts[i];
      const b = camPts[i + 1];

      const poly = this.clipPolygonNear([a.left, a.right, b.right, b.left]);
      if (poly.length < 3) continue;

      const projected = poly
        .map(p => this.projectCameraSpace(p))
        .filter((p): p is { x: number; y: number; z: number } => p !== null);
      if (projected.length < 3) continue;

      // 关键：clipPolygonNear 可能返回 3/4/5… 个顶点，顶点顺序不能假定为
      // [left, right, right, left]。这里单独投影该块的左右边界，
      // 供条带拼接使用——它们与路面使用的裁剪结果一致，因此严格贴合。
      //
      // 拼接顺序必须按世界深度（相机空间 z）而不是屏幕 y 来定：
      // 远处路面会越过地平线，此时「更远的点」在屏幕上反而更靠下，
      // 用屏幕 y 排序会让带子自交、画出条纹状的破碎路面。
      const leftSeg = this.clipSegmentNear(a.left, b.left);
      const rightSeg = this.clipSegmentNear(a.right, b.right);
      const lp = leftSeg
        ? [this.projectCameraSpace(leftSeg[0]), this.projectCameraSpace(leftSeg[1])]
        : null;
      const rp = rightSeg
        ? [this.projectCameraSpace(rightSeg[0]), this.projectCameraSpace(rightSeg[1])]
        : null;

      const depth = poly.reduce((s, p) => s + p.z, 0) / poly.length;
      segs.push({
        pts: projected.map(p => ({ x: p.x, y: p.y })),
        depth,
        // 统一成「近 -> 远」：clipSegmentNear 保持 a(near)→b(far) 的原始顺序
        left: lp && lp[0] && lp[1] ? [lp[0], lp[1]] : null,
        right: rp && rp[0] && rp[1] ? [rp[0], rp[1]] : null,
        // 用与路面完全相同的裁剪结果来画左右边线，避免「路面」和「白线」
        // 各自裁剪后位置上对不上而产生的重影
        leftSeg,
        rightSeg,
      });
    }

    // 远→近排序绘制
    segs.sort((a, b) => b.depth - a.depth);

    // 路面填充。
    //
    // 相邻四边形共享一条边，如果逐块 closePath+fill，共享边会被抗锯齿
    // 混合两次，在远处（每块不足 1 像素）累积成明显的接缝与重影。
    // 改为把「亮度档位相同且空间连续」的块拼成一条闭合带，一次 fill，
    // 从根本上消除接缝。
    this.fillRoadBands(segs.map(s => ({ left: s.left, right: s.right })));

    // 连续路边白线（左右各一条，与路面使用同一份裁剪结果）
    this.strokeClippedSegments(segs.map(s => s.leftSeg), 'rgba(255,255,255,0.55)', 2);
    this.strokeClippedSegments(segs.map(s => s.rightSeg), 'rgba(255,255,255,0.55)', 2);

    // 中线虚线：每 ROAD_MARK_PERIOD 米画一段
    const period = this.ROAD_MARK_PERIOD;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (let i = 0; i < camPts.length - 1; i++) {
      if (Math.floor(camPts[i].distance / period) % 2 !== 0) continue;
      const seg = this.clipSegmentNear(camPts[i].center, camPts[i + 1].center);
      if (!seg) continue;
      const a = this.projectCameraSpace(seg[0]);
      const b = this.projectCameraSpace(seg[1]);
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  /**
   * 画起点/终点线
   */
  private drawStartEnd(
    track: Track,
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
  ): void {
    const ctx = this.ctx;
    const hw = track.halfWidth;

    for (const [pt, isStart] of [[track.start, true], [track.end, false]] as const) {
      // 找到该点在赛道上的朝向
      const near = track.nearestPoint(pt.x, pt.z);
      // 横向 = 垂直于赛道方向；纵向 = 沿赛道方向
      const perpX = perpRight(near.heading).x;
      const perpZ = perpRight(near.heading).z;
      const fwdX = Math.sin(near.heading);
      const fwdZ = Math.cos(near.heading);
      const y = this.terrainHeight(pt.x, pt.z) + 0.1;

      const corners = [
        this.project(pt.x - perpX * hw, y, pt.z - perpZ * hw, camX, camY, camZ, yaw, pitch),
        this.project(pt.x + perpX * hw, y, pt.z + perpZ * hw, camX, camY, camZ, yaw, pitch),
        this.project(pt.x + perpX * hw + fwdX * 1.5, y, pt.z + perpZ * hw + fwdZ * 1.5, camX, camY, camZ, yaw, pitch),
        this.project(pt.x - perpX * hw + fwdX * 1.5, y, pt.z - perpZ * hw + fwdZ * 1.5, camX, camY, camZ, yaw, pitch),
      ].filter(p => p !== null) as { x: number; y: number }[];
      if (corners.length < 3) continue;

      // 棋盘格终点线 / 绿色起点线
      if (isStart) {
        ctx.fillStyle = 'rgba(76,175,80,0.8)';
      } else {
        // 黑白格
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
      }
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * 画技能道具（旋转的光柱+图标）
   */
  private drawSkillItem(
    item: { type: string; x: number; z: number },
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
  ): void {
    const ctx = this.ctx;
    const groundY = this.terrainHeight(item.x, item.z);
    if (this.isOccluded(item.x, item.z, groundY, camX, camY, camZ)) return;
    const base = this.project(item.x, groundY, item.z, camX, camY, camZ, yaw, pitch);
    if (!base) return;

    const fog = Math.max(0, 1 - base.z / this.FAR);
    const scale = this.focal / base.z;
    const time = performance.now() / 1000;
    const bob = Math.sin(time * 3 + item.x) * 0.15;

    // 光柱
    const top = this.project(item.x, groundY + 1.5 + bob, item.z, camX, camY, camZ, yaw, pitch);
    if (top) {
      const color = item.type === 'nitro' ? '255,152,0' : '0,188,212';
      const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
      grad.addColorStop(0, `rgba(${color},0.6)`);
      grad.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(base.x - scale * 0.3, base.y);
      ctx.lineTo(base.x + scale * 0.3, base.y);
      ctx.lineTo(top.x + scale * 0.15, top.y);
      ctx.lineTo(top.x - scale * 0.15, top.y);
      ctx.closePath();
      ctx.fill();

      // 顶部光球
      ctx.fillStyle = `rgba(${color},${0.9 * fog})`;
      ctx.beginPath();
      ctx.arc(top.x, top.y, Math.max(scale * 0.25, 3), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 视线遮挡检测：从相机到物体底部的连线上，如果有地形高于视线，则物体被遮挡
   */
  private isOccluded(
    objX: number, objZ: number, objY: number,
    camX: number, camY: number, camZ: number,
  ): boolean {
    const dx = objX - camX;
    const dz = objZ - camZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 5) return false; // 太近不检测

    const steps = Math.min(Math.floor(dist / 8), 15); // 每8米采样一次，最多15次
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = camX + dx * t;
      const z = camZ + dz * t;
      const terrainY = this.terrainHeight(x, z);
      const lineY = camY + (objY - camY) * t;
      if (terrainY > lineY + 0.3) return true; // 地形高于视线0.3米以上则遮挡
    }
    return false;
  }

  private drawObject(
    obj: SceneObject,
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
  ): void {
    const ctx = this.ctx;
    const groundY = this.terrainHeight(obj.x, obj.z);

    // 遮挡检测：物体底部是否被前方山坡遮挡
    if (this.isOccluded(obj.x, obj.z, groundY, camX, camY, camZ)) return;

    const base = this.project(obj.x, groundY, obj.z, camX, camY, camZ, yaw, pitch);
    if (!base) return;

    const fog = Math.max(0, 1 - base.z / this.FAR);
    const scale = this.focal / base.z;

    if (obj.type === 'tree') {
      const trunkH = 2.5 * scale;
      const crownR = 3 * scale;
      const trunkW = 0.35 * scale;
      ctx.fillStyle = `rgba(0,0,0,${0.2 * fog})`;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, crownR * 0.5, crownR * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(101 * fog + 30)},${Math.floor(67 * fog + 20)},${Math.floor(33 * fog + 15)},1)`;
      ctx.fillRect(base.x - trunkW / 2, base.y - trunkH, trunkW, trunkH);
      // 三层树冠
      ctx.fillStyle = `rgba(${Math.floor(27 * fog + 15)},${Math.floor(94 * fog + 25)},${Math.floor(32 * fog + 15)},1)`;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y - trunkH - crownR * 1.6);
      ctx.lineTo(base.x - crownR, base.y - trunkH);
      ctx.lineTo(base.x + crownR, base.y - trunkH);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(36 * fog + 15)},${Math.floor(110 * fog + 25)},${Math.floor(40 * fog + 15)},1)`;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y - trunkH - crownR * 1.1);
      ctx.lineTo(base.x - crownR * 0.75, base.y - trunkH * 0.4);
      ctx.lineTo(base.x + crownR * 0.75, base.y - trunkH * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(46 * fog + 15)},${Math.floor(125 * fog + 25)},${Math.floor(50 * fog + 15)},1)`;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y - trunkH - crownR * 0.6);
      ctx.lineTo(base.x - crownR * 0.5, base.y - trunkH * 0.1);
      ctx.lineTo(base.x + crownR * 0.5, base.y - trunkH * 0.1);
      ctx.closePath();
      ctx.fill();
    } else if (obj.type === 'bush') {
      const r = 1.8 * scale;
      ctx.fillStyle = `rgba(0,0,0,${0.15 * fog})`;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, r, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(56 * fog + 20)},${Math.floor(142 * fog + 30)},${Math.floor(60 * fog + 20)},1)`;
      ctx.beginPath();
      ctx.arc(base.x - r * 0.5, base.y - r * 0.4, r * 0.6, 0, Math.PI * 2);
      ctx.arc(base.x + r * 0.4, base.y - r * 0.5, r * 0.7, 0, Math.PI * 2);
      ctx.arc(base.x, base.y - r * 0.8, r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    } else if (obj.type === 'rock') {
      const rw = 1.5 * scale;
      const rh = 1 * scale;
      ctx.fillStyle = `rgba(0,0,0,${0.2 * fog})`;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, rw, rw * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle =`rgba(${Math.floor(120 * fog + 30)},${Math.floor(120 * fog + 30)},${Math.floor(125 * fog + 30)},1)`;
      ctx.beginPath();
      ctx.moveTo(base.x - rw, base.y);
      ctx.lineTo(base.x - rw * 0.5, base.y - rh);
      ctx.lineTo(base.x + rw * 0.3, base.y - rh * 1.2);
      ctx.lineTo(base.x + rw, base.y - rh * 0.3);
      ctx.lineTo(base.x + rw * 0.8, base.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(90 * fog + 25)},${Math.floor(90 * fog + 25)},${Math.floor(95 * fog + 25)},1)`;
      ctx.beginPath();
      ctx.moveTo(base.x - rw * 0.5, base.y - rh);
      ctx.lineTo(base.x + rw * 0.3, base.y - rh * 1.2);
      ctx.lineTo(base.x + rw * 0.1, base.y - rh * 0.4);
      ctx.closePath();
      ctx.fill();
    } else if (obj.type === 'cone') {
      const coneH = 1.2 * scale;
      const coneW = 0.45 * scale;
      ctx.fillStyle = `rgba(0,0,0,${0.2 * fog})`;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, coneW, coneW * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${Math.floor(255 * fog + 30)},${Math.floor(87 * fog + 15)},0,1)`;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y - coneH);
      ctx.lineTo(base.x - coneW, base.y);
      ctx.lineTo(base.x + coneW, base.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.9 * fog})`;
      ctx.fillRect(base.x - coneW * 0.5, base.y - coneH * 0.55, coneW, coneH * 0.12);
    }
  }

  /**
   * 前大灯光晕半径（像素）。
   *
   * 旧实现是 `min(r * 1.8, 25)`，其中 r 又能长到 18px，于是车头被两个
   * 直径 50px 的白球盖住。这里把上限收紧到 16px 并保留距离衰减。
   */
  headlightGlowRadius(depth: number, worldRadius = 0.17): number {
    if (!(depth > 0.01)) return 0;
    const r = Math.min(worldRadius * (this.focal / depth), 9);
    return Math.min(r * 2.2, 16);
  }

  /**
   * 画跑车（截面法：从车头到车尾的若干横截面，逐面着色）。
   *
   * 与旧实现相比的主要改进：
   *  1. 每个面按其法线方向做光照（顶面亮、侧面暗、背面最暗），不再是一整块纯色；
   *  2. 车轮按深度与车身合并排序绘制，且远侧车轮先画、被车身遮挡的部分不再
   *     糊在车漆上（旧实现把 4 个轮子无脑画在车身上，像贴了 4 个黑饼）；
   *  3. 大灯光晕大幅收敛并做距离衰减，不再是两个盖住车头的大白球；
   *  4. 补充接地阴影，车不再「浮」在地面上。
   */
  private drawCar(
    carX: number, carZ: number, heading: number,
    camX: number, camY: number, camZ: number, yaw: number, pitch: number,
    steerAngle: number,
  ): void {
    const ctx = this.ctx;
    const groundY = this.terrainHeight(carX, carZ);

    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    // 车局部坐标→世界坐标：x轴=车头方向(sin,cos)，z轴=右侧(cos,-sin)
    const toWorld = (v: Vec3): Vec3 => ({
      x: carX + v.x * sinH + v.z * cosH,
      y: groundY + v.y,
      z: carZ + v.x * cosH - v.z * sinH,
    });
    const proj = (v: Vec3) => this.project(v.x, v.y, v.z, camX, camY, camZ, yaw, pitch);

    // ===== 接地阴影（先画，被车身压住）=====
    // 用径向渐变画一个柔和的椭圆投影，而不是一块硬边矩形——
    // 硬边矩形看起来像车底下压了一张灰纸。
    const shadowCenter = proj(toWorld({ x: 0, y: 0.02, z: 0 }));
    if (shadowCenter) {
      const halfLen = Math.min(3.1 * (this.focal / shadowCenter.z), 400);
      const halfWid = Math.min(1.7 * (this.focal / shadowCenter.z), 260);
      if (halfLen > 1 && halfWid > 1) {
        ctx.save();
        ctx.translate(shadowCenter.x, shadowCenter.y);
        // 压扁成俯视投影的样子
        ctx.scale(1, halfWid / halfLen);
        const g = ctx.createRadialGradient(0, 0, halfLen * 0.15, 0, 0, halfLen);
        g.addColorStop(0, 'rgba(0,0,0,0.34)');
        g.addColorStop(0.65, 'rgba(0,0,0,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, halfLen, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // ===== 车身截面（从车头到车尾）=====
    // 车头压低、车顶隆起、车尾略收，形成跑车轮廓
    const sections = [
      { x: 2.30, topY: 0.50, bottomY: 0.24, hw: 0.86 }, // 0 车头
      { x: 1.60, topY: 0.68, bottomY: 0.24, hw: 0.90 }, // 1 引擎盖前
      { x: 0.90, topY: 0.76, bottomY: 0.24, hw: 0.88 }, // 2 引擎盖后（前挡风底）
      { x: 0.30, topY: 1.10, bottomY: 0.24, hw: 0.72 }, // 3 前挡风顶
      { x: -0.55, topY: 1.12, bottomY: 0.24, hw: 0.70 }, // 4 车顶后（后窗顶）
      { x: -1.15, topY: 0.80, bottomY: 0.24, hw: 0.84 }, // 5 后窗底
      { x: -1.80, topY: 0.70, bottomY: 0.24, hw: 0.88 }, // 6 后甲板
      { x: -2.30, topY: 0.60, bottomY: 0.24, hw: 0.86 }, // 7 车尾
    ];

    /** 车漆基色（红），配合不同面的明暗系数使用 */
    const paint = { r: 198, g: 40, b: 40 };
    const shade = (k: number, a = 1): string =>
      `rgba(${Math.round(paint.r * k)},${Math.round(paint.g * k)},${Math.round(paint.b * k)},${a})`;

    const glassDark = 'rgba(28,46,72,0.92)';
    const glassLight = 'rgba(96,150,196,0.55)';

    const pts = sections.map(s => ({
      bl: proj(toWorld({ x: s.x, y: s.bottomY, z: -s.hw })),
      br: proj(toWorld({ x: s.x, y: s.bottomY, z: s.hw })),
      tr: proj(toWorld({ x: s.x, y: s.topY, z: s.hw })),
      tl: proj(toWorld({ x: s.x, y: s.topY, z: -s.hw })),
      hw: s.hw,
      topY: s.topY,
      bottomY: s.bottomY,
      x: s.x,
    }));

    interface Face { pts: ({ x: number; y: number } | null)[]; depth: number; color: string; }
    const faces: Face[] = [];

    // 左侧面（从车头到车尾沿底边走，再沿顶边走回来）
    const leftSide = [
      ...pts.map(s => s.bl), ...pts.slice().reverse().map(s => s.tl),
    ];
    faces.push({ pts: leftSide, depth: avgDepth(leftSide), color: shade(0.55) });

    // 右侧面
    const rightSide = [
      ...pts.map(s => s.br), ...pts.slice().reverse().map(s => s.tr),
    ];
    faces.push({ pts: rightSide, depth: avgDepth(rightSide), color: shade(0.82) });

    // 上表面：相邻截面之间的四边形；2→3 与 4→5 是玻璃
    for (let i = 0; i < sections.length - 1; i++) {
      const quad = [pts[i].tl, pts[i].tr, pts[i + 1].tr, pts[i + 1].tl];
      let color = shade(1.0); // 车顶：最亮
      if (i === 2) color = glassDark;         // 前挡风（2→3）
      else if (i === 4) color = glassDark;    // 后窗（4→5）
      else if (i === 1) color = shade(0.97);  // 引擎盖
      else if (i === 3) color = shade(0.88);  // 车顶（3→4）：略暗于引擎盖，形成层次
      else if (i === 6) color = shade(0.9);   // 后甲板
      faces.push({ pts: quad, depth: avgDepth(quad) + 0.002, color });
    }

    // 车头面 / 车尾面
    const frontFace = [pts[0].bl, pts[0].br, pts[0].tr, pts[0].tl];
    faces.push({ pts: frontFace, depth: avgDepth(frontFace), color: shade(0.88) });
    const rearFace = [pts[pts.length - 1].bl, pts[pts.length - 1].br, pts[pts.length - 1].tr, pts[pts.length - 1].tl];
    faces.push({ pts: rearFace, depth: avgDepth(rearFace), color: shade(0.45) });

    // ===== 车轮（与车身一起按深度排序，远侧先画）=====
    const wheelPositions = [
      { x: 1.55, z: -0.94, front: true },
      { x: 1.55, z: 0.94, front: true },
      { x: -1.55, z: -0.94, front: false },
      { x: -1.55, z: 0.94, front: false },
    ];
    interface WheelDraw {
      order: number;
      depth: number;
      cx: number;
      cy: number;
      r: number;
      rear: boolean;
      side: number;
      angle: number;
    }
    const wheels: WheelDraw[] = [];
    for (const wp of wheelPositions) {
      const wheelAngle = wp.front ? steerAngle * 0.6 : 0;
      const wx = wp.x + (wp.front ? Math.sin(wheelAngle) * 0.12 : 0);
      const w2 = proj(toWorld({ x: wx, y: 0.36, z: wp.z }));
      if (!w2) continue;
      const r = Math.min(0.38 * (this.focal / w2.z), 60);
      if (r < 1.2) continue;
      wheels.push({
        order: 0, depth: w2.z, cx: w2.x, cy: w2.y, r,
        rear: wp.x < 0, side: Math.sign(wp.z), angle: wheelAngle,
      });
    }

    // 车身各面的深度用于与车轮合并排序
    const drawWheel = (w: WheelDraw): void => {
      // 轮胎（外圈）：远侧更暗，形成层次
      ctx.fillStyle = w.rear ? '#141414' : '#1b1b1b';
      ctx.beginPath();
      ctx.ellipse(w.cx, w.cy, w.r * 0.62, w.r, 0, 0, Math.PI * 2);
      ctx.fill();
      // 轮毂
      const rimR = w.r * 0.60;
      ctx.fillStyle = w.rear ? '#6f7276' : '#b9bdc2';
      ctx.beginPath();
      ctx.ellipse(w.cx, w.cy, rimR * 0.62, rimR, 0, 0, Math.PI * 2);
      ctx.fill();
      // 中心盖
      ctx.fillStyle = '#5a5d61';
      ctx.beginPath();
      ctx.ellipse(w.cx, w.cy, w.r * 0.13, w.r * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      // 辐条
      ctx.strokeStyle = w.rear ? 'rgba(40,42,45,0.8)' : 'rgba(70,74,78,0.85)';
      ctx.lineWidth = Math.max(w.r * 0.11, 0.6);
      for (let s = 0; s < 5; s++) {
        const a = (s / 5) * Math.PI * 2 + w.angle;
        ctx.beginPath();
        ctx.moveTo(w.cx + Math.cos(a) * w.r * 0.14, w.cy + Math.sin(a) * w.r * 0.14);
        ctx.lineTo(w.cx + Math.cos(a) * rimR * 0.9, w.cy + Math.sin(a) * rimR * 0.9);
        ctx.stroke();
      }
    };

    // 合并排序：远→近
    type Drawable = { depth: number; kind: 'face'; face: Face } | { depth: number; kind: 'wheel'; wheel: WheelDraw };
    const drawables: Drawable[] = [
      ...faces.map(f => ({ depth: f.depth, kind: 'face' as const, face: f })),
      ...wheels.map(w => ({ depth: w.depth, kind: 'wheel' as const, wheel: w })),
    ];
    drawables.sort((a, b) => b.depth - a.depth);

    for (const d of drawables) {
      if (d.kind === 'wheel') {
        drawWheel(d.wheel);
        continue;
      }
      const poly = d.face.pts.filter(pt => pt !== null) as { x: number; y: number }[];
      if (poly.length < 3) continue;
      ctx.fillStyle = d.face.color;
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fill();
    }

    // ===== 车身细节 =====
    // 侧窗（贴在座舱两侧，位于 3→4 截面之间）
    for (const side of [-1, 1] as const) {
      const a = proj(toWorld({ x: 0.42, y: 0.72, z: side * 0.79 }));
      const b = proj(toWorld({ x: 0.42, y: 1.14, z: side * 0.72 }));
      const c = proj(toWorld({ x: -0.42, y: 1.20, z: side * 0.70 }));
      const e = proj(toWorld({ x: -0.42, y: 0.78, z: side * 0.77 }));
      const quad = [a, b, c, e].filter(pt => pt !== null) as { x: number; y: number }[];
      if (quad.length >= 3) {
        ctx.fillStyle = glassLight;
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 腰线（侧面高光，勾出车身转折）
    for (const side of [-1, 1] as const) {
      const linePts: { x: number; y: number }[] = [];
      for (const s of sections) {
        const pp = proj(toWorld({ x: s.x, y: (s.topY + s.bottomY) / 2 + 0.03, z: side * s.hw * 0.97 }));
        if (pp) linePts.push(pp);
      }
      if (linePts.length >= 2) {
        ctx.strokeStyle = side > 0 ? 'rgba(255,190,190,0.30)' : 'rgba(0,0,0,0.30)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(linePts[0].x, linePts[0].y);
        for (let i = 1; i < linePts.length; i++) ctx.lineTo(linePts[i].x, linePts[i].y);
        ctx.stroke();
      }
    }

    // 前格栅
    const grille = [
      proj(toWorld({ x: 2.31, y: 0.28, z: -0.52 })),
      proj(toWorld({ x: 2.31, y: 0.28, z: 0.52 })),
      proj(toWorld({ x: 2.31, y: 0.44, z: 0.52 })),
      proj(toWorld({ x: 2.31, y: 0.44, z: -0.52 })),
    ].filter(pt => pt !== null) as { x: number; y: number }[];
    if (grille.length >= 3) {
      ctx.fillStyle = '#17181a';
      ctx.beginPath();
      ctx.moveTo(grille[0].x, grille[0].y);
      for (let i = 1; i < grille.length; i++) ctx.lineTo(grille[i].x, grille[i].y);
      ctx.closePath();
      ctx.fill();
    }

    // 前大灯：明亮但不夸张，带轻微光晕并按距离衰减
    for (const z of [-0.62, 0.62]) {
      const hp = proj(toWorld({ x: 2.30, y: 0.52, z }));
      if (!hp) continue;
      const r = Math.min(0.17 * (this.focal / hp.z), 9);
      if (r < 0.6) continue;
      const glowR = this.headlightGlowRadius(hp.z, 0.17);
      const glow = ctx.createRadialGradient(hp.x, hp.y, 1, hp.x, hp.y, glowR);
      glow.addColorStop(0, 'rgba(255,248,214,0.55)');
      glow.addColorStop(1, 'rgba(255,248,214,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fffdf0';
      ctx.beginPath();
      ctx.ellipse(hp.x, hp.y, Math.max(r, 1), Math.max(r * 0.62, 0.8), 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 尾灯（车尾两侧横条）
    for (const z of [-0.60, 0.60]) {
      const tp = proj(toWorld({ x: -2.31, y: 0.56, z }));
      if (!tp) continue;
      const w = Math.min(0.30 * (this.focal / tp.z), 14);
      const h = Math.max(w * 0.34, 0.8);
      if (w < 0.8) continue;
      ctx.fillStyle = 'rgba(255,23,68,0.92)';
      ctx.fillRect(tp.x - w / 2, tp.y - h / 2, w, h);
    }

    // 尾翼
    const wingLocal = [
      { x: -2.05, y: 0.98, z: -0.80 },
      { x: -2.05, y: 0.98, z: 0.80 },
      { x: -2.32, y: 0.98, z: 0.80 },
      { x: -2.32, y: 0.98, z: -0.80 },
    ];
    const wing = wingLocal.map(v => proj(toWorld(v))).filter(pt => pt !== null) as { x: number; y: number }[];
    if (wing.length >= 3) {
      ctx.fillStyle = shade(0.38);
      ctx.beginPath();
      ctx.moveTo(wing[0].x, wing[0].y);
      for (let i = 1; i < wing.length; i++) ctx.lineTo(wing[i].x, wing[i].y);
      ctx.closePath();
      ctx.fill();
    }

    // 后视镜
    for (const z of [-0.98, 0.98]) {
      const mp = proj(toWorld({ x: 0.75, y: 0.86, z }));
      if (!mp) continue;
      const r = Math.min(0.16 * (this.focal / mp.z), 7);
      if (r < 0.7) continue;
      ctx.fillStyle = shade(0.5);
      ctx.beginPath();
      ctx.ellipse(mp.x, mp.y, Math.max(r * 1.15, 1.2), Math.max(r * 0.75, 0.9), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}

function avgDepth(pts: ({ z: number } | null)[]): number {
  const valid = pts.filter(p => p !== null) as { z: number }[];
  if (valid.length === 0) return Infinity;
  return valid.reduce((s, p) => s + p.z, 0) / valid.length;
}
