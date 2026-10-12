/**
 * 程序化赛道生成器（无尽模式）
 * 从起点出发，交替生成直道和弯道段，可无限追加。
 */
import { Track, type TrackPoint } from './Track.js';

export interface TrackGenConfig {
  seed?: number;
  width?: number;
}

/**
 * 带种子的伪随机数生成器
 */
export class SeededRandom {
  private seed: number;
  constructor(seed?: number) {
    this.seed = seed ?? Math.floor(Math.random() * 1000000);
  }
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/**
 * 无尽赛道生成器
 * 维护当前末端位置和朝向，每次调用 generateNext() 生成一段直道或弯道。
 */
export class EndlessTrackGenerator {
  private rng: SeededRandom;
  private currentX: number;
  private currentZ: number;
  private currentHeading: number;
  private segmentCount: number = 0;

  constructor(seed?: number, startX = 0, startZ = 0, startHeading = 0) {
    this.rng = new SeededRandom(seed);
    this.currentX = startX;
    this.currentZ = startZ;
    this.currentHeading = startHeading;
  }

  /**
   * 生成下一段赛道（直道或弯道），返回新增的路径点
   */
  generateNext(): TrackPoint[] {
    this.segmentCount++;
    const isCurve = this.segmentCount > 1 && this.rng.next() < 0.5;

    if (isCurve) {
      return this.generateCurve();
    } else {
      return this.generateStraight();
    }
  }

  private generateStraight(): TrackPoint[] {
    const len = this.rng.range(50, 120);
    const pts: TrackPoint[] = [];
    // 细分直道，每10米一个点
    const steps = Math.ceil(len / 10);
    for (let i = 1; i <= steps; i++) {
      const d = (len * i) / steps;
      pts.push({
        x: this.currentX + Math.sin(this.currentHeading) * d,
        z: this.currentZ + Math.cos(this.currentHeading) * d,
      });
    }
    this.currentX += Math.sin(this.currentHeading) * len;
    this.currentZ += Math.cos(this.currentHeading) * len;
    return pts;
  }

  private generateCurve(): TrackPoint[] {
    const angle = this.rng.range(0.3, 1.0) * (this.rng.next() < 0.5 ? 1 : -1);
    const radius = this.rng.range(35, 70);
    const arcLength = Math.abs(angle) * radius;
    const steps = Math.max(4, Math.ceil(arcLength / 8));
    const startHeading = this.currentHeading;
    const pts: TrackPoint[] = [];

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const curAngle = startHeading + angle * t;
      const stepLen = arcLength / steps;
      this.currentX += Math.sin(curAngle) * stepLen;
      this.currentZ += Math.cos(curAngle) * stepLen;
      pts.push({ x: this.currentX, z: this.currentZ });
    }
    this.currentHeading = startHeading + angle;
    return pts;
  }

  getEndPosition(): { x: number; z: number; heading: number } {
    return { x: this.currentX, z: this.currentZ, heading: this.currentHeading };
  }
}

/**
 * 创建初始赛道（包含起点和前几段）
 */
export function createInitialTrack(seed?: number, width = 12): { track: Track; generator: EndlessTrackGenerator } {
  const generator = new EndlessTrackGenerator(seed);
  const points: TrackPoint[] = [{ x: 0, z: 0 }];

  // 先生成4段作为初始赛道
  for (let i = 0; i < 4; i++) {
    const newPts = generator.generateNext();
    points.push(...newPts);
  }

  const track = new Track(points, width, false);
  return { track, generator };
}

/**
 * 兼容旧接口：生成一条固定赛道（用于测试）
 */
export function generateDefaultTrack(): Track {
  const { track } = createInitialTrack(20261005);
  return track;
}
