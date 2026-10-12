/**
 * 技能系统
 * 赛道上随机生成技能道具，车碰到后触发效果。
 * 技能类型：加速(Nitro)、自动驾驶(AutoDrive)
 */

export type SkillType = 'nitro' | 'autodrive';

export interface SkillItem {
  id: number;
  type: SkillType;
  x: number;
  z: number;
  collected: boolean;
  respawnTimer: number; // 重新生成倒计时（秒），0表示已生成
}

export interface ActiveSkill {
  type: SkillType;
  remaining: number; // 剩余持续时间（秒）
}

export class SkillSystem {
  public items: SkillItem[] = [];
  public active: ActiveSkill | null = null;

  private readonly RESPAWN_TIME = 15; // 道具重生时间（秒）
  private readonly NITRO_DURATION = 5;
  private readonly AUTODRIVE_DURATION = 8;
  private nextId = 0;

  constructor() {}

  /**
   * 在赛道上随机生成技能道具
   */
  spawnOnTrack(track: { sampleAtDistance: (d: number) => { x: number; z: number } }, totalLength: number, count: number): void {
    this.items = [];
    for (let i = 0; i < count; i++) {
      const d = (totalLength / (count + 1)) * (i + 1) + (Math.random() - 0.5) * 20;
      const pt = track.sampleAtDistance(Math.max(0, Math.min(d, totalLength)));
      // 随机偏移到赛道一侧
      const offset = (Math.random() - 0.5) * 6;
      const angle = Math.random() * Math.PI * 2;
      this.items.push({
        id: this.nextId++,
        type: Math.random() < 0.6 ? 'nitro' : 'autodrive',
        x: pt.x + Math.cos(angle) * offset,
        z: pt.z + Math.sin(angle) * offset,
        collected: false,
        respawnTimer: 0,
      });
    }
  }

  /**
   * 在赛道新增段上追加技能道具（无尽生成用）
   */
  extendOnTrack(
    track: { sampleAtDistance: (d: number) => { x: number; z: number } },
    oldLength: number,
    newLength: number,
    count: number,
  ): void {
    const segmentLen = newLength - oldLength;
    for (let i = 0; i < count; i++) {
      const d = oldLength + (segmentLen / (count + 1)) * (i + 1) + (Math.random() - 0.5) * 15;
      const pt = track.sampleAtDistance(Math.max(0, Math.min(d, newLength)));
      const offset = (Math.random() - 0.5) * 6;
      const angle = Math.random() * Math.PI * 2;
      this.items.push({
        id: this.nextId++,
        type: Math.random() < 0.6 ? 'nitro' : 'autodrive',
        x: pt.x + Math.cos(angle) * offset,
        z: pt.z + Math.sin(angle) * offset,
        collected: false,
        respawnTimer: 0,
      });
    }
  }

  /**
   * 每帧更新：检查碰撞、更新持续时间、重生道具
   */
  update(carX: number, carZ: number, dt: number): void {
    // 检查道具碰撞
    for (const item of this.items) {
      if (item.collected) {
        item.respawnTimer -= dt;
        if (item.respawnTimer <= 0) {
          item.collected = false;
        }
        continue;
      }
      const dist = Math.hypot(carX - item.x, carZ - item.z);
      if (dist < 2.5) {
        this.collect(item);
      }
    }

    // 更新激活的技能
    if (this.active) {
      this.active.remaining -= dt;
      if (this.active.remaining <= 0) {
        this.active = null;
      }
    }
  }

  private collect(item: SkillItem): void {
    item.collected = true;
    item.respawnTimer = this.RESPAWN_TIME;
    const duration = item.type === 'nitro' ? this.NITRO_DURATION : this.AUTODRIVE_DURATION;
    this.active = { type: item.type, remaining: duration };
  }

  /**
   * 是否有加速效果
   */
  hasNitro(): boolean {
    return this.active?.type === 'nitro';
  }

  /**
   * 是否有自动驾驶效果
   */
  hasAutoDrive(): boolean {
    return this.active?.type === 'autodrive';
  }

  /**
   * 获取加速倍率
   */
  getNitroMultiplier(): number {
    return this.hasNitro() ? 1.8 : 1.0;
  }

  /**
   * 获取当前激活技能的剩余时间
   */
  getActiveRemaining(): number {
    return this.active?.remaining ?? 0;
  }

  /**
   * 获取当前激活技能类型
   */
  getActiveType(): SkillType | null {
    return this.active?.type ?? null;
  }
}
