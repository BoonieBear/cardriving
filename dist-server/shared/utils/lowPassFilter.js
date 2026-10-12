/**
 * 低通滤波器 - 用于陀螺仪数据降噪，消除静置抖动
 */
export class LowPassFilter {
    alpha;
    lastValue;
    initialized;
    /**
     * @param alpha 滤波系数 [0,1]，越小越平滑但延迟越大
     *              陀螺仪推荐 0.1 - 0.3
     */
    constructor(alpha = 0.2) {
        this.alpha = alpha;
        this.lastValue = 0;
        this.initialized = false;
    }
    /**
     * 输入新值，返回滤波后的值
     */
    filter(value) {
        if (!this.initialized) {
            this.lastValue = value;
            this.initialized = true;
            return value;
        }
        this.lastValue = this.lastValue + this.alpha * (value - this.lastValue);
        return this.lastValue;
    }
    /**
     * 重置滤波器状态
     */
    reset() {
        this.lastValue = 0;
        this.initialized = false;
    }
    /**
     * 动态调整滤波系数
     */
    setAlpha(alpha) {
        this.alpha = Math.max(0, Math.min(1, alpha));
    }
}
/**
 * 三维低通滤波器（用于陀螺仪 x/y/z 三轴）
 */
export class LowPassFilter3D {
    x;
    y;
    z;
    constructor(alpha = 0.2) {
        this.x = new LowPassFilter(alpha);
        this.y = new LowPassFilter(alpha);
        this.z = new LowPassFilter(alpha);
    }
    filter(x, y, z) {
        return {
            x: this.x.filter(x),
            y: this.y.filter(y),
            z: this.z.filter(z),
        };
    }
    reset() {
        this.x.reset();
        this.y.reset();
        this.z.reset();
    }
}
//# sourceMappingURL=lowPassFilter.js.map