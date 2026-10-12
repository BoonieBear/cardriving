/**
 * 陀螺仪采集与处理
 * 负责设备方向采集、低通滤波、死区处理、校准、转向映射
 */
import { LowPassFilter } from '../../../shared/utils/lowPassFilter.js';
import { clamp, applyDeadzone, mapRange } from '../../../shared/utils/math.js';

export interface GyroscopeState {
  steer: number;       // [-1, 1] 转向输出
  rawGamma: number;     // 原始 gamma 角（度）
  filteredGamma: number; // 滤波后 gamma 角
  calibrated: boolean;  // 是否已校准
  permissionGranted: boolean; // 权限是否已授予
}

export class Gyroscope {
  private filter: LowPassFilter;
  private state: GyroscopeState;

  // 校准偏移
  private calibrationOffset: number = 0;

  // 配置
  private readonly deadzone: number = 0.08;      // 死区（归一化后）
  private readonly maxTiltAngle: number = 35;     // 最大倾斜角（度），超过此角度满舵
  private readonly filterAlpha: number = 0.15;    // 滤波系数

  // 事件处理引用（用于移除监听）
  private orientationHandler: ((e: DeviceOrientationEvent) => void) | null = null;

  constructor() {
    this.filter = new LowPassFilter(this.filterAlpha);
    this.state = {
      steer: 0,
      rawGamma: 0,
      filteredGamma: 0,
      calibrated: false,
      permissionGranted: false,
    };
  }

  /**
   * 请求陀螺仪权限（iOS 13+ 需要）
   */
  async requestPermission(): Promise<boolean> {
    try {
      // iOS 13+ 的权限请求 API
      const anyEvent = DeviceOrientationEvent as any;
      if (typeof anyEvent.requestPermission === 'function') {
        const permission = await anyEvent.requestPermission();
        if (permission === 'granted') {
          this.state.permissionGranted = true;
          console.log('[Gyro] 陀螺仪权限已授予');
          return true;
        } else {
          console.warn('[Gyro] 陀螺仪权限被拒绝');
          return false;
        }
      }
      // 非 iOS 设备，默认有权限
      this.state.permissionGranted = true;
      return true;
    } catch (e) {
      console.error('[Gyro] 请求陀螺仪权限失败', e);
      return false;
    }
  }

  /**
   * 启动陀螺仪采集
   */
  start(): boolean {
    if (!this.state.permissionGranted) {
      console.warn('[Gyro] 未授权，无法启动陀螺仪');
      return false;
    }

    if (this.orientationHandler) {
      console.warn('[Gyro] 陀螺仪已在运行');
      return true;
    }

    this.orientationHandler = (e: DeviceOrientationEvent) => {
      this.handleOrientation(e);
    };

    window.addEventListener('deviceorientation', this.orientationHandler);
    console.log('[Gyro] 陀螺仪采集已启动');
    return true;
  }

  /**
   * 停止陀螺仪采集
   */
  stop(): void {
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = null;
      console.log('[Gyro] 陀螺仪采集已停止');
    }
  }

  /**
   * 校准：将当前姿态设为零点
   */
  calibrate(): void {
    this.calibrationOffset = this.state.filteredGamma;
    this.state.calibrated = true;
    this.filter.reset();
    console.log(`[Gyro] 已校准，偏移量: ${this.calibrationOffset.toFixed(2)}°`);
  }

  /**
   * 处理设备方向事件
   */
  private handleOrientation(e: DeviceOrientationEvent): void {
    const gamma = e.gamma ?? 0; // 左右倾斜角 [-90, 90]
    this.state.rawGamma = gamma;

    // 低通滤波
    const filtered = this.filter.filter(gamma);
    this.state.filteredGamma = filtered;

    // 减去校准偏移
    const adjusted = filtered - this.calibrationOffset;

    // 映射到 [-1, 1]
    let steer = mapRange(adjusted, -this.maxTiltAngle, this.maxTiltAngle, -1, 1);
    steer = clamp(steer, -1, 1);

    // 死区处理
    steer = applyDeadzone(steer, this.deadzone);

    this.state.steer = steer;
  }

  /**
   * 获取当前转向值 [-1, 1]
   */
  getSteer(): number {
    return this.state.steer;
  }

  /**
   * 获取完整状态
   */
  getState(): GyroscopeState {
    return { ...this.state };
  }

  /**
   * 检查设备是否支持陀螺仪
   */
  static isSupported(): boolean {
    return 'DeviceOrientationEvent' in window;
  }

  /**
   * 检查是否需要请求权限（iOS 13+）
   */
  static needsPermission(): boolean {
    const anyEvent = DeviceOrientationEvent as any;
    return typeof anyEvent.requestPermission === 'function';
  }
}
