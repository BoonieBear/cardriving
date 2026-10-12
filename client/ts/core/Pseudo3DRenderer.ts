/**
 * 伪3D渲染器 — 真实世界坐标版
 * 纯 Canvas 2D，零 WebGL。使用 CarPhysics 的真实世界坐标 (x, z, heading)，
 * 车可以自由左右转弯、开上草地，赛道仅作为视觉背景。
 */

interface SegmentSprite {
  type: 'tree' | 'cone' | 'bush';
  offset: number; // 路宽单位（1 = 路边）
}

interface RoadSegment {
  curve: number;
  sprites: SegmentSprite[];
}

interface ProjectedPoint {
  x: number;
  y: number;
  scale: number;
  z: number;
}

export class Pseudo3DRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // ===== 世界常量 =====
  private readonly ROAD_WIDTH = 2000;       // 路全宽（伪3D单位）
  private readonly SEGMENT_LENGTH = 200;    // 每段路长
  private readonly RUMBLE_LENGTH = 3;       // 路缘颜色交替段数
  private readonly CAMERA_HEIGHT = 1000;    // 相机高度
  private readonly DRAW_DISTANCE = 300;     // 渲染段数
  private readonly FOV = 100;               // 视野角
  private readonly WORLD_SCALE = 60;        // 物理米 → 伪3D单位

  private segments: RoadSegment[] = [];
  private trackLength = 0;

  // 运行时（由外部物理状态驱动）
  public offRoad = false;

  private w = 0;
  private h = 0;

  private tilt = 0;
  private clouds: { x: number; y: number; s: number; speed: number }[] = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;position:absolute;top:0;left:0;';
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    container.appendChild(this.canvas);
    this.buildTrack();
    this.buildClouds();
    window.addEventListener('resize', this.resize);
  }

  private resize = (): void => {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w;
    this.canvas.height = this.h;
  };

  private buildClouds(): void {
    this.clouds = [];
    for (let i = 0; i < 8; i++) {
      this.clouds.push({
        x: Math.random() * this.w,
        y: 20 + Math.random() * (this.h * 0.25),
        s: 0.5 + Math.random() * 1.2,
        speed: 5 + Math.random() * 15,
      });
    }
  }

  /**
   * 构建闭环赛道（总曲率=0）
   */
  private buildTrack(): void {
    this.segments = [];

    const add = (curve: number) => {
      const sprites: SegmentSprite[] = [];
      const r = Math.random();
      if (r < 0.25) {
        sprites.push({
          type: r < 0.16 ? 'tree' : 'bush',
          offset: (Math.random() < 0.5 ? -1 : 1) * (1.3 + Math.random() * 2.5),
        });
      } else if (r < 0.30) {
        sprites.push({
          type: 'cone',
          offset: (Math.random() < 0.5 ? -1 : 1) * 1.15,
        });
      }
      this.segments.push({ curve, sprites });
    };

    const straight = (n: number) => { for (let i = 0; i < n; i++) add(0); };
    const curve = (n: number, c: number) => { for (let i = 0; i < n; i++) add(c); };

    straight(20);
    curve(20, 2);     // +40
    straight(15);
    curve(30, -3);    // -90
    straight(15);
    curve(25, 4);     // +100
    straight(20);
    curve(20, -2.5);  // -50
    straight(15);
    // 总计: 40 - 90 + 100 - 50 = 0

    this.trackLength = this.segments.length * this.SEGMENT_LENGTH;
  }

  /**
   * 投影一个点到屏幕坐标
   */
  private project(
    worldZ: number,
    camX: number,
    camDepth: number,
  ): ProjectedPoint | null {
    if (worldZ <= camDepth) return null;
    const scale = camDepth / worldZ;
    return {
      x: this.w / 2 + scale * (-camX) * (this.w / 2),
      y: this.h / 2 + scale * this.CAMERA_HEIGHT * (this.h / 2),
      scale,
      z: worldZ,
    };
  }

  /**
   * 渲染一帧
   * @param carX 车辆世界X（米）
   * @param carZ 车辆世界Z（米，前进方向）
   * @param heading 车辆朝向角（弧度）
   * @param speed 车速（m/s）
   * @param steerAngle 前轮转向角（弧度）
   * @param isDrifting 是否漂移
   * @param dt 帧间隔（秒）
   */
  render(
    carX: number,
    carZ: number,
    heading: number,
    speed: number,
    steerAngle: number,
    isDrifting: boolean,
    dt: number,
  ): void {
    const ctx = this.ctx;

    // ===== 物理坐标 → 伪3D世界坐标 =====
    const playerWorldX = carX * this.WORLD_SCALE;
    const playerWorldZ = carZ * this.WORLD_SCALE;
    const trackPos = ((playerWorldZ % this.trackLength) + this.trackLength) % this.trackLength;
    const playerX = playerWorldX / this.ROAD_WIDTH; // 路宽单位，无上限

    this.offRoad = Math.abs(playerX) > 1.0;

    // 屏幕倾斜（基于真实转向角）
    const targetTilt = isDrifting ? steerAngle * 0.12 : steerAngle * 0.06;
    this.tilt += (targetTilt - this.tilt) * (1 - Math.exp(-dt * 5));

    for (const c of this.clouds) {
      c.x += c.speed * dt;
      if (c.x > this.w + 200) c.x = -200;
    }

    const horizon = this.h * 0.42;
    const camDepth = 1 / Math.tan((this.FOV / 2) * Math.PI / 180);

    // heading 旋转的三角函数
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    // ===== 屏幕倾斜 =====
    ctx.save();
    ctx.translate(this.w / 2, horizon);
    ctx.rotate(this.tilt);
    ctx.translate(-this.w / 2, -horizon);

    // ===== 天空 =====
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#1565c0');
    sky.addColorStop(0.5, '#42a5f5');
    sky.addColorStop(1, '#bbdefb');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, this.w, horizon);

    // 云
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const c of this.clouds) this.drawCloud(c.x, c.y, c.s);

    // 远山
    ctx.fillStyle = '#7cb342';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (let x = 0; x <= this.w; x += 30) {
      const hh = 25 + Math.sin(x * 0.004 + 1) * 18 + Math.sin(x * 0.011 + 3) * 10;
      ctx.lineTo(x, horizon - hh);
    }
    ctx.lineTo(this.w, horizon);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#558b2f';
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (let x = 0; x <= this.w; x += 20) {
      const hh = 12 + Math.sin(x * 0.008 + 5) * 10 + Math.sin(x * 0.02) * 5;
      ctx.lineTo(x, horizon - hh);
    }
    ctx.lineTo(this.w, horizon);
    ctx.closePath();
    ctx.fill();

    // ===== 地面 =====
    const ground = ctx.createLinearGradient(0, horizon, 0, this.h);
    ground.addColorStop(0, '#689f38');
    ground.addColorStop(0.3, '#558b2f');
    ground.addColorStop(1, '#33691e');
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, this.w, this.h - horizon);

    // ===== 道路 =====
    const baseIdx = Math.floor(trackPos / this.SEGMENT_LENGTH) % this.segments.length;
    const basePct = (trackPos % this.SEGMENT_LENGTH) / this.SEGMENT_LENGTH;
    const baseSeg = this.segments[baseIdx];

    // 累计曲线偏移（赛道世界X）
    let curveX = 0;
    let curveDX = -(baseSeg.curve * basePct);
    let maxY = this.h;

    const sprites: { x: number; y: number; scale: number; type: SegmentSprite['type']; z: number }[] = [];

    for (let n = 0; n < this.DRAW_DISTANCE; n++) {
      const segIdx = (baseIdx + n) % this.segments.length;
      const seg = this.segments[segIdx];

      // 路段近边/远边沿赛道方向的距离
      const z1 = (n - basePct) * this.SEGMENT_LENGTH;
      const z2 = z1 + this.SEGMENT_LENGTH;

      // 路段世界X（近边/远边）
      const segWorldX1 = curveX;
      const segWorldX2 = curveX + curveDX;

      // 相对于玩家的世界坐标
      const relX1 = segWorldX1 - playerWorldX;
      const relZ1 = z1;
      const relX2 = segWorldX2 - playerWorldX;
      const relZ2 = z2;

      // 用 heading 旋转到相机局部坐标
      // 相机前向 = (sinH, cosH)，相机右向 = (cosH, -sinH)
      // localForward = relX * sinH + relZ * cosH
      // localRight   = relX * cosH - relZ * sinH
      // camX = -localRight
      const depth1 = relX1 * sinH + relZ1 * cosH;
      const camX1 = -(relX1 * cosH - relZ1 * sinH);
      const depth2 = relX2 * sinH + relZ2 * cosH;
      const camX2 = -(relX2 * cosH - relZ2 * sinH);

      const p1 = this.project(depth1, camX1, camDepth);
      const p2 = this.project(depth2, camX2, camDepth);

      // 推进累计偏移
      curveX += curveDX;
      curveDX += seg.curve;

      if (!p2) continue;
      if (!p1) continue;

      if (p2.y >= p1.y) continue;
      if (p2.y >= maxY) continue;

      const rw1 = p1.scale * this.ROAD_WIDTH * (this.w / 2) / 2;
      const rw2 = p2.scale * this.ROAD_WIDTH * (this.w / 2) / 2;
      const light = Math.floor(n / this.RUMBLE_LENGTH) % 2 === 0;

      // 路面
      ctx.fillStyle = this.offRoad
        ? light ? '#6d5c3a' : '#5e4f30'
        : light ? '#555555' : '#4a4a4a';
      ctx.beginPath();
      ctx.moveTo(p1.x - rw1, p1.y);
      ctx.lineTo(p1.x + rw1, p1.y);
      ctx.lineTo(p2.x + rw2, p2.y);
      ctx.lineTo(p2.x - rw2, p2.y);
      ctx.closePath();
      ctx.fill();

      // 路缘带
      const rr1 = Math.max(rw1 * 0.12, 2);
      const rr2 = Math.max(rw2 * 0.12, 2);
      ctx.fillStyle = light ? '#f5f5f5' : '#d32f2f';
      ctx.beginPath();
      ctx.moveTo(p1.x - rw1 - rr1, p1.y);
      ctx.lineTo(p1.x - rw1, p1.y);
      ctx.lineTo(p2.x - rw2, p2.y);
      ctx.lineTo(p2.x - rw2 - rr2, p2.y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p1.x + rw1, p1.y);
      ctx.lineTo(p1.x + rw1 + rr1, p1.y);
      ctx.lineTo(p2.x + rw2 + rr2, p2.y);
      ctx.lineTo(p2.x + rw2, p2.y);
      ctx.closePath();
      ctx.fill();

      // 白色中线（虚线）
      if (light && rw1 > 4) {
        const lw1 = Math.max(rw1 * 0.025, 1);
        const lw2 = Math.max(rw2 * 0.025, 1);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(p1.x - lw1, p1.y);
        ctx.lineTo(p1.x + lw1, p1.y);
        ctx.lineTo(p2.x + lw2, p2.y);
        ctx.lineTo(p2.x - lw2, p2.y);
        ctx.closePath();
        ctx.fill();
      }

      // 收集路边精灵
      for (const spr of seg.sprites) {
        const sprWorldX = segWorldX1 + spr.offset * this.ROAD_WIDTH / 2;
        const sprRelX = sprWorldX - playerWorldX;
        const sprRelZ = z1;
        const sprDepth = sprRelX * sinH + sprRelZ * cosH;
        const sprCamX = -(sprRelX * cosH - sprRelZ * sinH);
        if (sprDepth > camDepth) {
          const sprScale = camDepth / sprDepth;
          const sprX = this.w / 2 + sprScale * (-sprCamX) * (this.w / 2);
          const sprY = this.h / 2 + sprScale * this.CAMERA_HEIGHT * (this.h / 2);
          if (sprX > -300 && sprX < this.w + 300 && sprScale > 0.0005 && sprY < maxY) {
            sprites.push({ x: sprX, y: sprY, scale: sprScale, type: spr.type, z: sprDepth });
          }
        }
      }

      maxY = p2.y;
    }

    // 绘制精灵（远→近）
    sprites.sort((a, b) => b.z - a.z);
    for (const spr of sprites) this.drawSprite(spr);

    // ===== 速度线 =====
    const speedNorm = Math.min(Math.abs(speed) / 45, 1);
    if (speedNorm > 0.3) {
      const alpha = (speedNorm - 0.3) * 0.3;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 1.5;
      const cx = this.w / 2;
      const cy = horizon;
      for (let i = 0; i < 14; i++) {
        const angle = (i / 14) * Math.PI * 2 + trackPos * 0.005;
        const r1 = Math.min(this.w, this.h) * 0.3;
        const r2 = r1 + speedNorm * 90;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
        ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
        ctx.stroke();
      }
    }

    ctx.restore();

    // ===== 车头引擎盖 + 方向盘 =====
    this.drawHood(steerAngle);
  }

  private drawCloud(x: number, y: number, s: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, 18 * s, 0, Math.PI * 2);
    ctx.arc(x + 20 * s, y - 5 * s, 22 * s, 0, Math.PI * 2);
    ctx.arc(x + 42 * s, y, 18 * s, 0, Math.PI * 2);
    ctx.arc(x + 22 * s, y + 8 * s, 16 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSprite(spr: { x: number; y: number; scale: number; type: SegmentSprite['type'] }): void {
    const ctx = this.ctx;
    const size = spr.scale * this.CAMERA_HEIGHT * (this.h / 2);
    if (size < 2) return;

    if (spr.type === 'tree') {
      const trunkH = size * 0.3;
      const crownH = size * 0.85;
      const crownW = size * 0.5;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(spr.x, spr.y, crownW * 0.5, size * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#6d4c41';
      ctx.fillRect(spr.x - size * 0.05, spr.y - trunkH, size * 0.1, trunkH);
      ctx.fillStyle = '#2e7d32';
      ctx.beginPath();
      ctx.moveTo(spr.x, spr.y - trunkH - crownH);
      ctx.lineTo(spr.x - crownW / 2, spr.y - trunkH);
      ctx.lineTo(spr.x + crownW / 2, spr.y - trunkH);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#388e3c';
      ctx.beginPath();
      ctx.moveTo(spr.x, spr.y - trunkH - crownH * 0.7);
      ctx.lineTo(spr.x - crownW * 0.35, spr.y - trunkH * 0.5);
      ctx.lineTo(spr.x + crownW * 0.35, spr.y - trunkH * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (spr.type === 'bush') {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.ellipse(spr.x, spr.y, size * 0.2, size * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#43a047';
      ctx.beginPath();
      ctx.arc(spr.x - size * 0.1, spr.y - size * 0.1, size * 0.16, 0, Math.PI * 2);
      ctx.arc(spr.x + size * 0.1, spr.y - size * 0.12, size * 0.18, 0, Math.PI * 2);
      ctx.arc(spr.x, spr.y - size * 0.2, size * 0.15, 0, Math.PI * 2);
      ctx.fill();
    } else if (spr.type === 'cone') {
      const coneH = size * 0.5;
      const coneW = size * 0.18;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(spr.x, spr.y, coneW, size * 0.04, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff6f00';
      ctx.beginPath();
      ctx.moveTo(spr.x, spr.y - coneH);
      ctx.lineTo(spr.x - coneW, spr.y);
      ctx.lineTo(spr.x + coneW, spr.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(spr.x - coneW * 0.55, spr.y - coneH * 0.55, coneW * 1.1, coneH * 0.14);
      ctx.fillStyle = '#333';
      ctx.fillRect(spr.x - coneW * 1.1, spr.y - size * 0.02, coneW * 2.2, size * 0.04);
    }
  }

  private drawHood(steerAngle: number): void {
    const ctx = this.ctx;
    const hoodH = this.h * 0.17;
    const y = this.h - hoodH;

    const grad = ctx.createLinearGradient(0, y, 0, this.h);
    grad.addColorStop(0, '#c62828');
    grad.addColorStop(0.4, '#b71c1c');
    grad.addColorStop(1, '#7f0000');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    ctx.lineTo(0, y + hoodH * 0.35);
    ctx.quadraticCurveTo(this.w * 0.2, y - hoodH * 0.05, this.w * 0.5, y - hoodH * 0.05);
    ctx.quadraticCurveTo(this.w * 0.8, y - hoodH * 0.05, this.w, y + hoodH * 0.35);
    ctx.lineTo(this.w, this.h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(this.w * 0.1, y + hoodH * 0.3);
    ctx.quadraticCurveTo(this.w * 0.5, y - hoodH * 0.02, this.w * 0.9, y + hoodH * 0.3);
    ctx.lineTo(this.w * 0.85, y + hoodH * 0.4);
    ctx.quadraticCurveTo(this.w * 0.5, y + hoodH * 0.1, this.w * 0.15, y + hoodH * 0.4);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.w / 2, y);
    ctx.lineTo(this.w / 2, this.h);
    ctx.stroke();

    const wheelR = Math.max(hoodH * 0.3, 20);
    const wheelX = this.w / 2;
    const wheelY = this.h - wheelR * 0.15;
    ctx.save();
    ctx.translate(wheelX, wheelY);
    ctx.rotate(steerAngle * 1.2);

    ctx.strokeStyle = '#212121';
    ctx.lineWidth = wheelR * 0.18;
    ctx.beginPath();
    ctx.moveTo(0, wheelR * 0.3);
    ctx.lineTo(0, wheelR * 1.2);
    ctx.stroke();

    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = wheelR * 0.14;
    ctx.beginPath();
    ctx.arc(0, 0, wheelR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#424242';
    ctx.lineWidth = wheelR * 0.06;
    ctx.beginPath();
    ctx.arc(0, 0, wheelR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#212121';
    ctx.lineWidth = wheelR * 0.1;
    ctx.beginPath();
    ctx.moveTo(-wheelR * 0.85, 0);
    ctx.lineTo(wheelR * 0.85, 0);
    ctx.moveTo(0, -wheelR * 0.85);
    ctx.lineTo(0, wheelR * 0.4);
    ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.arc(0, 0, wheelR * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}
