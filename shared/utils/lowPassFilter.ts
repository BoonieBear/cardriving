/**
 * 低通滤波器 - 用于陀螺仪数据降噪，消除静置抖动
 */

export class LowPassFilter {
  private alpha: number;
  private lastValue: number;
  private initialized: boolean;

  /**
   * @param alpha 滤波系数 [0,1]，越小越平滑但延迟越大
   *              陀螺仪推荐 0.1 - 0.3
   */
  constructor(alpha: number = 0.2) {
    this.alpha = alpha;
    this.lastValue = 0;
    this.initialized = false;
  }

  /**
   * 输入新值，返回滤波后的值
   */
  filter(value: number): number {
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
  reset(): void {
    this.lastValue = 0;
    this.initialized = false;
  }

  /**
   * 动态调整滤波系数
   */
  setAlpha(alpha: number): void {
    this.alpha = Math.max(0, Math.min(1, alpha));
  }
}

/**
 * 三维低通滤波器（用于陀螺仪 x/y/z 三轴）
 */
export class LowPassFilter3D {
  private x: LowPassFilter;
  private y: LowPassFilter;
  private z: LowPassFilter;

  constructor(alpha: number = 0.2) {
    this.x = new LowPassFilter(alpha);
    this.y = new LowPassFilter(alpha);
    this.z = new LowPassFilter(alpha);
  }

  filter(x: number, y: number, z: number): { x: number; y: number; z: number } {
    return {
      x: this.x.filter(x),
      y: this.y.filter(y),
      z: this.z.filter(z),
    };
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}
