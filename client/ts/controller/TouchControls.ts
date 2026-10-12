/**
 * 铰接式触控踏板
 * 垂直滑块：手指在踏板行程内上下滑动控制油门/刹车力度。
 *
 * 机械手感由此处驱动：
 *  - 行程值写入 CSS 变量 --pedal，踏板摇臂 / 踏板面 / 读数条全部由 CSS 联动
 *  - 踩到底 / 松开的瞬间触发一次振动，模拟金属触底
 */
import { pedalTravelFromClientY, pedalPercentText } from './ControlMapping.js';
import { Haptics } from './Haptics.js';

interface PedalRef {
  container: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
  thumb: HTMLElement;
  readout: HTMLElement | null;
  touchId: number | null;
  value: number;
  /** 上一次是否处于「踩到底」，用于只在触底瞬间震动 */
  atBottom: boolean;
}

export class TouchControls {
  private brake: PedalRef;
  private throttle: PedalRef;
  private haptics: Haptics;

  /** 判定「踩到底」的行程阈值 */
  private readonly bottomThreshold = 0.98;

  constructor(
    brakeId: string,
    throttleId: string,
    brakeFillId: string,
    throttleFillId: string,
    haptics: Haptics = new Haptics(),
  ) {
    this.haptics = haptics;
    this.brake = this.initPedal(brakeId, brakeFillId, 'brake');
    this.throttle = this.initPedal(throttleId, throttleFillId, 'throttle');
  }

  private initPedal(containerId: string, fillId: string, kind: 'brake' | 'throttle'): PedalRef {
    const container = document.getElementById(containerId)!;
    const track = container.querySelector('.pedal-track') as HTMLElement;
    const fill = document.getElementById(fillId)!;
    const thumb = container.querySelector('.pedal-thumb') as HTMLElement;
    const readout = document.getElementById(`${kind}-readout`);

    const pedal: PedalRef = {
      container,
      track,
      fill,
      thumb,
      readout,
      touchId: null,
      value: 0,
      atBottom: false,
    };

    this.bindPedalEvents(pedal);
    this.setPedalValue(pedal, 0);
    return pedal;
  }

  private bindPedalEvents(pedal: PedalRef): void {
    const el = pedal.container;

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      pedal.touchId = touch.identifier;
      this.updatePedalFromTouch(pedal, touch.clientY);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === pedal.touchId) {
          this.updatePedalFromTouch(pedal, t.clientY);
        }
      }
    }, { passive: false });

    const endHandler = (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === pedal.touchId) {
          pedal.touchId = null;
          if (pedal.value > 0) this.haptics.pedalRelease();
          this.setPedalValue(pedal, 0);
        }
      }
    };
    el.addEventListener('touchend', endHandler, { passive: false });
    el.addEventListener('touchcancel', endHandler, { passive: false });

    // 鼠标调试（桌面）
    let mouseDown = false;
    el.addEventListener('mousedown', (e) => {
      mouseDown = true;
      pedal.touchId = -1;
      this.updatePedalFromTouch(pedal, e.clientY);
    });
    window.addEventListener('mousemove', (e) => {
      if (mouseDown && pedal.touchId === -1) {
        this.updatePedalFromTouch(pedal, e.clientY);
      }
    });
    window.addEventListener('mouseup', () => {
      if (pedal.touchId !== -1) return;
      mouseDown = false;
      pedal.touchId = null;
      if (pedal.value > 0) this.haptics.pedalRelease();
      this.setPedalValue(pedal, 0);
    });

    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * 根据触摸 Y 坐标计算踏板力度
   * track 底部 = 0，顶部 = 1
   */
  private updatePedalFromTouch(pedal: PedalRef, clientY: number): void {
    const rect = pedal.track.getBoundingClientRect();
    const value = pedalTravelFromClientY(clientY, rect.top, rect.height);
    this.setPedalValue(pedal, value);
  }

  private setPedalValue(pedal: PedalRef, value: number): void {
    pedal.value = value;
    pedal.fill.style.height = `${value * 100}%`;
    pedal.thumb.style.bottom = `${value * 100}%`;
    // 摇臂摆角 / 踏板面倾斜 / 高亮全部由 CSS 变量驱动
    pedal.container.style.setProperty('--pedal', value.toFixed(3));
    pedal.container.dataset.full = value >= this.bottomThreshold ? '1' : '0';
    if (pedal.readout) pedal.readout.textContent = pedalPercentText(value);

    // 只在「刚踩到底」的那一帧给出触底反馈，避免持续震动
    const atBottom = value >= this.bottomThreshold;
    if (atBottom && !pedal.atBottom) this.haptics.pedalBottom();
    pedal.atBottom = atBottom;
  }

  getThrottle(): number {
    return this.throttle.value;
  }

  getBrake(): number {
    return this.brake.value;
  }

  reset(): void {
    this.setPedalValue(this.brake, 0);
    this.setPedalValue(this.throttle, 0);
    this.brake.touchId = null;
    this.throttle.touchId = null;
  }
}
