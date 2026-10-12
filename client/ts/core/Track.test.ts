/**
 * @vitest-environment jsdom
 *
 * Track 赛道系统单元测试
 */
import { describe, it, expect } from 'vitest';
import { Track, createDefaultTrack } from './Track';

describe('Track — 基础', () => {
  it('创建赛道后总长度 > 0', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.totalLength).toBeCloseTo(100);
  });

  it('默认赛道有起点和终点', () => {
    const track = createDefaultTrack();
    expect(track.start).toBeDefined();
    expect(track.end).toBeDefined();
    expect(track.totalLength).toBeGreaterThan(100);
  });

  it('赛道宽度和半宽正确', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 50 }], 12);
    expect(track.width).toBe(12);
    expect(track.halfWidth).toBe(6);
  });
});

describe('Track — 路径采样', () => {
  it('sampleAtDistance(0) 返回起点', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    const s = track.sampleAtDistance(0);
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(0);
  });

  it('sampleAtDistance(totalLength) 返回终点', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    const s = track.sampleAtDistance(100);
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(100);
  });

  it('sampleAtDistance 中间点正确插值', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    const s = track.sampleAtDistance(50);
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(50);
  });

  it('斜线段采样正确', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 30, z: 40 }], 10);
    expect(track.totalLength).toBeCloseTo(50);
    const s = track.sampleAtDistance(25);
    expect(s.x).toBeCloseTo(15);
    expect(s.z).toBeCloseTo(20);
  });
});

describe('Track — 最近点查询', () => {
  it('赛道中心线上的点 distToTrack ≈ 0', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    const near = track.nearestPoint(0, 50);
    expect(near.distToTrack).toBeLessThan(0.1);
  });

  it('赛道外的点 distToTrack > 0', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    const near = track.nearestPoint(20, 50);
    expect(near.distToTrack).toBeCloseTo(20);
  });

  it('isOnTrack 对赛道内点返回 true', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.isOnTrack(0, 50)).toBe(true);
    expect(track.isOnTrack(4, 50)).toBe(true);
  });

  it('isOnTrack 对赛道外点返回 false', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.isOnTrack(10, 50)).toBe(false);
  });
});

describe('Track — 进度计算', () => {
  it('起点进度 ≈ 0', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.getProgress(0, 0)).toBeLessThan(0.05);
  });

  it('终点进度 ≈ 1', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.getProgress(0, 100)).toBeGreaterThan(0.95);
  });

  it('中点进度 ≈ 0.5', () => {
    const track = new Track([{ x: 0, z: 0 }, { x: 0, z: 100 }], 10);
    expect(track.getProgress(0, 50)).toBeCloseTo(0.5, 1);
  });
});

describe('Track — 轮廓采样', () => {
  it('sampleOutline 返回非空数组', () => {
    const track = createDefaultTrack();
    const outline = track.sampleOutline(20);
    expect(outline.length).toBeGreaterThan(5);
  });
});
