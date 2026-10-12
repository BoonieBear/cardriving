/**
 * 赛道系统
 * 定义一条有弯道的闭合/开放赛道，提供路径采样、最近点查询、进度计算。
 * 赛道由一系列路径点（waypoint）组成，道路沿路径点的平滑曲线生成。
 */

export interface TrackPoint {
  x: number;
  z: number;
}

export interface TrackSample {
  x: number;
  z: number;
  heading: number;  // 该点的朝向角（弧度）
  segmentIndex: number;
  segmentT: number; // 在当前段内的进度 [0,1]
  distance: number; // 从起点到该点的累计距离
}

export class Track {
  public points: TrackPoint[];
  public readonly width: number;       // 赛道宽度（米）
  public readonly halfWidth: number;
  public totalLength: number = 0;
  public start: TrackPoint;
  public end: TrackPoint;
  public readonly startHeading: number;
  public readonly cyclic: boolean;     // 是否循环（无尽赛道）

  // 预计算的段长度和累计距离
  private segmentLengths: number[] = [];
  private cumulativeDist: number[] = [];

  constructor(points: TrackPoint[], width: number = 12, cyclic: boolean = false) {
    this.points = points;
    this.width = width;
    this.halfWidth = width / 2;
    this.cyclic = cyclic;
    this.start = points[0];
    this.end = points[points.length - 1];
    this.recompute();
    this.startHeading = Math.atan2(points[1].x - points[0].x, points[1].z - points[0].z);
  }

  /**
   * 重新计算段长度和累计距离（追加点后调用）
   */
  private recompute(): void {
    this.segmentLengths = [];
    this.cumulativeDist = [0];
    let total = 0;
    const segCount = this.cyclic ? this.points.length : this.points.length - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = this.points[i];
      const p1 = this.cyclic ? this.points[(i + 1) % this.points.length] : this.points[i + 1];
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      this.segmentLengths.push(len);
      total += len;
      this.cumulativeDist.push(total);
    }
    this.totalLength = total;
    this.end = this.points[this.points.length - 1];
  }

  /**
   * 动态追加路径点（用于无尽生成）
   */
  appendPoints(newPoints: TrackPoint[]): void {
    if (newPoints.length === 0) return;
    // 跳过与最后一个点重复的
    const last = this.points[this.points.length - 1];
    const startIdx = (Math.hypot(newPoints[0].x - last.x, newPoints[0].z - last.z) < 0.1) ? 1 : 0;
    for (let i = startIdx; i < newPoints.length; i++) {
      this.points.push(newPoints[i]);
    }
    this.recompute();
  }

  /**
   * 获取赛道上指定距离处的点（循环模式下自动取模）
   */
  sampleAtDistance(distance: number): TrackSample {
    let d = distance;
    if (this.cyclic) {
      d = ((d % this.totalLength) + this.totalLength) % this.totalLength;
    } else {
      d = Math.max(0, Math.min(distance, this.totalLength));
    }
    // 二分查找所在段
    let lo = 0, hi = this.segmentLengths.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulativeDist[mid + 1] < d) lo = mid + 1;
      else hi = mid;
    }
    const segIdx = lo;
    const segStart = this.cumulativeDist[segIdx];
    const segLen = this.segmentLengths[segIdx];
    const t = segLen > 0 ? (d - segStart) / segLen : 0;

    const p0 = this.points[segIdx];
    const p1 = this.cyclic ? this.points[(segIdx + 1) % this.points.length] : this.points[segIdx + 1];
    const x = p0.x + (p1.x - p0.x) * t;
    const z = p0.z + (p1.z - p0.z) * t;
    const heading = Math.atan2(p1.x - p0.x, p1.z - p0.z);

    return { x, z, heading, segmentIndex: segIdx, segmentT: t, distance: d };
  }

  /**
   * 查找赛道上离给定点最近的点
   */
  nearestPoint(x: number, z: number): TrackSample & { distToTrack: number; lateralOffset: number } {
    let bestDist = Infinity;
    let bestSample: TrackSample | null = null;
    let bestOffset = 0;

    const segCount = this.cyclic ? this.points.length : this.points.length - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = this.points[i];
      const p1 = this.cyclic ? this.points[(i + 1) % this.points.length] : this.points[i + 1];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const segLen2 = dx * dx + dz * dz;
      if (segLen2 < 0.001) continue;

      // 投影到线段
      let t = ((x - p0.x) * dx + (z - p0.z) * dz) / segLen2;
      t = Math.max(0, Math.min(1, t));
      const px = p0.x + dx * t;
      const pz = p0.z + dz * t;
      const dist = Math.hypot(x - px, z - pz);

      if (dist < bestDist) {
        bestDist = dist;
        const heading = Math.atan2(dx, dz);
        bestSample = {
          x: px, z: pz, heading,
          segmentIndex: i, segmentT: t,
          distance: this.cumulativeDist[i] + t * this.segmentLengths[i],
        };
        // 横向偏移：正=在赛道右侧，负=左侧
        const perpX = -dz / Math.sqrt(segLen2);
        const perpZ = dx / Math.sqrt(segLen2);
        bestOffset = (x - px) * perpX + (z - pz) * perpZ;
      }
    }

    return {
      ...bestSample!,
      distToTrack: bestDist,
      lateralOffset: bestOffset,
    };
  }

  /**
   * 判断点是否在赛道范围内
   */
  isOnTrack(x: number, z: number): boolean {
    const near = this.nearestPoint(x, z);
    return near.distToTrack <= this.halfWidth;
  }

  /**
   * 获取赛道进度 [0,1]
   */
  getProgress(x: number, z: number): number {
    const near = this.nearestPoint(x, z);
    return near.distance / this.totalLength;
  }

  /**
   * 采样赛道轮廓点（用于小地图），返回等间距的点列表
   */
  sampleOutline(spacing: number = 10): TrackPoint[] {
    const result: TrackPoint[] = [];
    for (let d = 0; d <= this.totalLength; d += spacing) {
      const s = this.sampleAtDistance(d);
      result.push({ x: s.x, z: s.z });
    }
    return result;
  }
}

/**
 * 创建一条预设赛道（有弯道的山间赛道）
 */
export function createDefaultTrack(): Track {
  const points: TrackPoint[] = [
    { x: 0, z: 0 },
    { x: 0, z: 80 },
    { x: 30, z: 120 },
    { x: 80, z: 140 },
    { x: 140, z: 130 },
    { x: 180, z: 90 },
    { x: 190, z: 40 },
    { x: 170, z: -10 },
    { x: 120, z: -40 },
    { x: 60, z: -30 },
    { x: 20, z: 10 },
    { x: 0, z: 50 },
    { x: 0, z: 200 }, // 终点直道
  ];
  return new Track(points, 12);
}
