/**
 * @vitest-environment jsdom
 *
 * SkillSystem 技能系统单元测试
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SkillSystem } from './SkillSystem';

function createMockTrack() {
  return {
    sampleAtDistance: (d: number) => ({ x: d, z: 0, heading: 0 }),
  };
}

describe('SkillSystem — 道具生成', () => {
  it('spawnOnTrack 生成指定数量的道具', () => {
    const sys = new SkillSystem();
    sys.spawnOnTrack(createMockTrack(), 500, 6);
    expect(sys.items.length).toBe(6);
  });

  it('生成的道具类型为 nitro 或 autodrive', () => {
    const sys = new SkillSystem();
    sys.spawnOnTrack(createMockTrack(), 500, 10);
    for (const item of sys.items) {
      expect(['nitro', 'autodrive']).toContain(item.type);
    }
  });

  it('新生成的道具未被收集', () => {
    const sys = new SkillSystem();
    sys.spawnOnTrack(createMockTrack(), 500, 5);
    for (const item of sys.items) {
      expect(item.collected).toBe(false);
    }
  });
});

describe('SkillSystem — 碰撞收集', () => {
  it('车碰到道具后收集并激活', () => {
    const sys = new SkillSystem();
    sys.spawnOnTrack(createMockTrack(), 500, 1);
    const item = sys.items[0];
    sys.update(item.x, item.z, 0.016);
    expect(item.collected).toBe(true);
    expect(sys.active).not.toBeNull();
  });

  it('nitro 道具激活后 hasNitro() 返回 true', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'nitro', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    expect(sys.hasNitro()).toBe(true);
    expect(sys.hasAutoDrive()).toBe(false);
  });

  it('autodrive 道具激活后 hasAutoDrive() 返回 true', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'autodrive', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    expect(sys.hasAutoDrive()).toBe(true);
    expect(sys.hasNitro()).toBe(false);
  });

  it('nitro 倍率为 1.8', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'nitro', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    expect(sys.getNitroMultiplier()).toBe(1.8);
  });

  it('无激活技能时倍率为 1.0', () => {
    const sys = new SkillSystem();
    expect(sys.getNitroMultiplier()).toBe(1.0);
  });
});

describe('SkillSystem — 持续时间', () => {
  it('激活的技能随时间减少', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'nitro', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    const remaining1 = sys.getActiveRemaining();
    sys.update(100, 100, 1.0); // 远离道具，过1秒
    const remaining2 = sys.getActiveRemaining();
    expect(remaining2).toBeLessThan(remaining1);
  });

  it('技能持续时间结束后失效', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'nitro', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    expect(sys.active).not.toBeNull();
    // 快进10秒（超过5秒持续时间）
    sys.update(100, 100, 10);
    expect(sys.active).toBeNull();
  });
});

describe('SkillSystem — 道具重生', () => {
  it('收集后的道具在重生时间后恢复', () => {
    const sys = new SkillSystem();
    sys.items = [{ id: 0, type: 'nitro', x: 0, z: 0, collected: false, respawnTimer: 0 }];
    sys.update(0, 0, 0.016);
    expect(sys.items[0].collected).toBe(true);
    // 快进20秒（超过15秒重生时间）
    sys.update(100, 100, 20);
    expect(sys.items[0].collected).toBe(false);
  });
});
