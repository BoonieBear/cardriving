/**
 * 数值限制工具
 */
/**
 * 将值限制在 [min, max] 范围内
 */
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
/**
 * 线性插值
 */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
/**
 * 将值从 [inMin, inMax] 映射到 [outMin, outMax]
 */
export function mapRange(value, inMin, inMax, outMin, outMax) {
    return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}
/**
 * 死区处理：值在 [-threshold, threshold] 内时返回 0
 */
export function applyDeadzone(value, threshold) {
    if (Math.abs(value) < threshold)
        return 0;
    // 死区外重新映射，保证从 0 平滑过渡
    const sign = value > 0 ? 1 : -1;
    return sign * ((Math.abs(value) - threshold) / (1 - threshold));
}
/**
 * 赛道/车辆朝向的单位前向量
 * 约定：heading=0 朝 +Z，heading 增大朝 +X 旋转
 * @returns 前向单位向量 (x, z)
 */
export function forwardVector(heading) {
    return { x: Math.sin(heading), z: Math.cos(heading) };
}
/**
 * 朝向的右手侧单位横向向量（垂直于 heading 方向）
 *
 * 注意：这里必须使用真正的垂直方向。
 * 曾经的错误实现用了 (-sin, cos)——那其实是「前向」向量本身，
 * 会把道路宽度叠加在赛道长度方向上，导致路面退化成一条线、
 * 且屏幕上的宽度随相机与赛道的夹角变化。
 *
 * @returns 垂直于前进方向的单位向量 (x, z)
 */
export function perpRight(heading) {
    return { x: Math.cos(heading), z: -Math.sin(heading) };
}
/**
 * 角度归一化到 [-PI, PI]
 */
export function normalizeAngle(angle) {
    while (angle > Math.PI)
        angle -= 2 * Math.PI;
    while (angle < -Math.PI)
        angle += 2 * Math.PI;
    return angle;
}
//# sourceMappingURL=math.js.map