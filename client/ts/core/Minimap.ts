/**
 * 小地图渲染器
 * 在左下角显示赛道线路、车辆位置/朝向、终点、技能道具
 */
import type { Track } from './Track.js';
import type { SkillSystem } from './SkillSystem.js';

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private readonly SIZE = 180;
  private readonly PADDING = 12;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.SIZE;
    this.canvas.height = this.SIZE;
    this.canvas.style.cssText = `
      position:absolute;
      left:16px;
      bottom:16px;
      width:${this.SIZE}px;
      height:${this.SIZE}px;
      border-radius:12px;
      border:2px solid rgba(0,212,255,0.4);
      background:rgba(10,10,20,0.8);
      z-index:40;
      backdrop-filter:blur(8px);
    `;
    this.ctx = this.canvas.getContext('2d')!;
    container.appendChild(this.canvas);
  }

  /**
   * 渲染小地图
   */
  render(
    track: Track,
    carX: number,
    carZ: number,
    carHeading: number,
    skillSystem: SkillSystem,
  ): void {
    const ctx = this.ctx;
    const size = this.SIZE;
    const pad = this.PADDING;

    ctx.clearRect(0, 0, size, size);

    // 计算赛道边界
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of track.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const trackW = maxX - minX;
    const trackH = maxZ - minZ;
    const scale = Math.min((size - pad * 2) / trackW, (size - pad * 2) / trackH);
    const offsetX = (size - trackW * scale) / 2 - minX * scale;
    const offsetZ = (size - trackH * scale) / 2 - minZ * scale;

    const toMap = (x: number, z: number) => ({
      x: x * scale + offsetX,
      y: z * scale + offsetZ,
    });

    // 赛道背景（半透明宽线）
    ctx.strokeStyle = 'rgba(100,100,120,0.5)';
    ctx.lineWidth = track.width * scale * 0.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const first = toMap(track.points[0].x, track.points[0].z);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < track.points.length; i++) {
      const p = toMap(track.points[i].x, track.points[i].z);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // 赛道中心线
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < track.points.length; i++) {
      const p = toMap(track.points[i].x, track.points[i].z);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 起点（绿色方块）
    const start = toMap(track.start.x, track.start.z);
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(start.x - 4, start.y - 4, 8, 8);

    // 终点（红色旗帜）
    const end = toMap(track.end.x, track.end.z);
    ctx.fillStyle = '#f44336';
    ctx.beginPath();
    ctx.moveTo(end.x, end.y - 6);
    ctx.lineTo(end.x + 8, end.y - 3);
    ctx.lineTo(end.x, end.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#f44336';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y - 6);
    ctx.lineTo(end.x, end.y + 4);
    ctx.stroke();

    // 技能道具
    for (const item of skillSystem.items) {
      if (item.collected) continue;
      const p = toMap(item.x, item.z);
      if (item.type === 'nitro') {
        ctx.fillStyle = '#ff9800';
      } else {
        ctx.fillStyle = '#00bcd4';
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 车辆位置（三角形，指向朝向）
    const car = toMap(carX, carZ);
    ctx.save();
    ctx.translate(car.x, car.y);
    // 小地图把世界 (x, z) 直接映射为屏幕 (x, y)，因此 +Z 在图上朝下。
    // canvas 的 rotate() 是「顺时针为正」，而世界 heading 是「从 +Z 转向 +X」，
    // 两者在图上恰好是同一个顺时针方向，所以必须用 -heading 才能对齐。
    // 历史上这里传了 +heading，箭头指向与车头方向关于地图中心镜像（例如朝正前时
    // 箭头偏向左上），修掉该 bug 后箭头尖始终落在世界前向 (sin h, cos h) 上。
    ctx.rotate(-carHeading);
    // 三角形尖朝下(+y)，即世界的 +Z 方向
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(0, 7);
    ctx.lineTo(5, -5);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // 标签
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px monospace';
    ctx.fillText('MAP', pad, size - pad + 2);
  }

  dispose(): void {
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}
