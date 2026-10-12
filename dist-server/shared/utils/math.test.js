/**
 * 数值与朝向工具测试
 * 重点覆盖 forwardVector / perpRight 的方向正确性（道路宽度回归依赖）
 */
import { describe, it, expect } from 'vitest';
import { clamp, lerp, mapRange, applyDeadzone, normalizeAngle, forwardVector, perpRight } from './math';
describe('math — 基础数值工具', () => {
    it('clamp 限制在区间内', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(11, 0, 10)).toBe(10);
    });
    it('lerp 线性插值', () => {
        expect(lerp(0, 10, 0)).toBe(0);
        expect(lerp(0, 10, 1)).toBe(10);
        expect(lerp(0, 10, 0.25)).toBe(2.5);
    });
    it('mapRange 映射区间', () => {
        expect(mapRange(0, -1, 1, -10, 10)).toBe(0);
        expect(mapRange(1, -1, 1, -10, 10)).toBeCloseTo(10, 10);
    });
    it('applyDeadzone 死区内归零、死区外平滑过渡', () => {
        expect(applyDeadzone(0.05, 0.1)).toBe(0);
        expect(applyDeadzone(-0.05, 0.1)).toBe(0);
        expect(applyDeadzone(1, 0.1)).toBeCloseTo(1, 10);
        // 死区边界外侧从 0 开始连续
        expect(applyDeadzone(0.1 + 1e-6, 0.1)).toBeCloseTo(0, 5);
    });
    it('normalizeAngle 归一化到 [-PI, PI]', () => {
        expect(normalizeAngle(0)).toBeCloseTo(0, 10);
        expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
        // -3π 与 π、-π 等价，取边界值即可
        expect(Math.abs(normalizeAngle(-3 * Math.PI))).toBeCloseTo(Math.PI, 10);
    });
});
describe('math — 朝向向量', () => {
    it('forwardVector：heading=0 朝 +Z，heading=PI/2 朝 +X', () => {
        const f0 = forwardVector(0);
        expect(f0.x).toBeCloseTo(0, 10);
        expect(f0.z).toBeCloseTo(1, 10);
        const f90 = forwardVector(Math.PI / 2);
        expect(f90.x).toBeCloseTo(1, 10);
        expect(f90.z).toBeCloseTo(0, 10);
    });
    it('forwardVector 是单位向量', () => {
        for (const h of [0, 0.3, 1.2, Math.PI, -2.1]) {
            const f = forwardVector(h);
            expect(Math.hypot(f.x, f.z)).toBeCloseTo(1, 10);
        }
    });
    it('perpRight 与 forwardVector 正交（点积为 0）', () => {
        for (const h of [0, 0.3, 1.2, Math.PI, -2.1, 5.6]) {
            const f = forwardVector(h);
            const p = perpRight(h);
            expect(f.x * p.x + f.z * p.z).toBeCloseTo(0, 10);
        }
    });
    it('perpRight 是单位向量', () => {
        for (const h of [0, 0.3, 1.2, Math.PI, -2.1, 5.6]) {
            const p = perpRight(h);
            expect(Math.hypot(p.x, p.z)).toBeCloseTo(1, 10);
        }
    });
    it('perpRight 指向前进方向的右手侧', () => {
        // heading=0（朝 +Z）时，右手侧是 +X
        const p0 = perpRight(0);
        expect(p0.x).toBeCloseTo(1, 10);
        expect(p0.z).toBeCloseTo(0, 10);
        // heading=PI/2（朝 +X）时，右手侧是 -Z
        const p90 = perpRight(Math.PI / 2);
        expect(p90.x).toBeCloseTo(0, 10);
        expect(p90.z).toBeCloseTo(-1, 10);
    });
    it('回归：perpRight 不得等于 forwardVector（旧 bug 会返回前向量）', () => {
        for (const h of [0, 0.7, 2.4, -1.1]) {
            const f = forwardVector(h);
            const p = perpRight(h);
            const sameDirection = Math.hypot(f.x - p.x, f.z - p.z);
            expect(sameDirection).toBeGreaterThan(0.1);
        }
    });
});
//# sourceMappingURL=math.test.js.map