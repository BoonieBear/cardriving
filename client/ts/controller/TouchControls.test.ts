/**
 * @vitest-environment jsdom
 *
 * 铰接踏板触控测试
 * 覆盖：行程映射、DOM 联动（CSS 变量 / 读数 / 触底标记）、触觉反馈、
 *      鼠标与触摸两条输入路径、reset
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TouchControls } from './TouchControls';
import { Haptics } from './Haptics';

const TRACK_TOP = 100;
const TRACK_HEIGHT = 200;

function pedalMarkup(kind: 'brake' | 'throttle'): string {
  const id = kind === 'brake' ? 'btn-brake' : 'btn-throttle';
  return `
    <div id="${id}" class="pedal pedal-${kind}">
      <div class="pedal-head">
        <span class="pedal-name">${kind}</span>
        <span id="${kind}-readout" class="pedal-readout">0%</span>
      </div>
      <div class="pedal-track">
        <div class="pedal-rail"></div>
        <div id="${kind}-bar-fill" class="pedal-fill"></div>
        <div id="${kind}-slider" class="pedal-thumb">
          <span class="pedal-hinge"></span>
          <span class="pedal-arm"></span>
          <span class="pedal-plate"></span>
        </div>
      </div>
    </div>`;
}

function setupDom(): void {
  document.body.innerHTML = `<div class="pedal-group">${pedalMarkup('brake')}${pedalMarkup('throttle')}</div>`;
  // jsdom 不做布局，手动给行程轨道一个矩形
  document.querySelectorAll('.pedal-track').forEach(el => {
    (el as HTMLElement).getBoundingClientRect = () => ({
      top: TRACK_TOP, height: TRACK_HEIGHT,
      left: 0, right: 100, bottom: TRACK_TOP + TRACK_HEIGHT,
      width: 100, x: 0, y: TRACK_TOP, toJSON: () => ({}),
    }) as DOMRect;
  });
}

function touchEvent(type: string, touches: { identifier: number; clientY: number }[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: touches });
  return e;
}

function createControls(haptics?: Haptics): TouchControls {
  return new TouchControls('btn-brake', 'btn-throttle', 'brake-bar-fill', 'throttle-bar-fill', haptics);
}

describe('TouchControls — 踏板行程', () => {
  beforeEach(setupDom);

  it('初始状态两个踏板都在 0', () => {
    const c = createControls();
    expect(c.getThrottle()).toBe(0);
    expect(c.getBrake()).toBe(0);
  });

  it('触摸轨道顶部 = 满行程，底部 = 0', () => {
    const c = createControls();
    const throttle = document.getElementById('btn-throttle')!;

    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP }]));
    expect(c.getThrottle()).toBeCloseTo(1, 6);

    throttle.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientY: TRACK_TOP + TRACK_HEIGHT }]));
    expect(c.getThrottle()).toBeCloseTo(0, 6);
  });

  it('刹车与油门互相独立（双指同时操作）', () => {
    const c = createControls();
    const brake = document.getElementById('btn-brake')!;
    const throttle = document.getElementById('btn-throttle')!;

    brake.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP + TRACK_HEIGHT / 2 }]));
    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientY: TRACK_TOP }]));

    expect(c.getBrake()).toBeCloseTo(0.5, 6);
    expect(c.getThrottle()).toBeCloseTo(1, 6);
  });

  it('抬手后踏板归零', () => {
    const c = createControls();
    const brake = document.getElementById('btn-brake')!;
    brake.dispatchEvent(touchEvent('touchstart', [{ identifier: 7, clientY: TRACK_TOP }]));
    expect(c.getBrake()).toBeCloseTo(1, 6);

    brake.dispatchEvent(touchEvent('touchend', [{ identifier: 7, clientY: TRACK_TOP }]));
    expect(c.getBrake()).toBe(0);
  });

  it('忽略非本踏板手指的移动事件', () => {
    const c = createControls();
    const throttle = document.getElementById('btn-throttle')!;
    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP + TRACK_HEIGHT }]));
    expect(c.getThrottle()).toBe(0);

    // 另一个 identifier 不应影响行程
    throttle.dispatchEvent(touchEvent('touchmove', [{ identifier: 99, clientY: TRACK_TOP }]));
    expect(c.getThrottle()).toBe(0);
  });

  it('reset 清空两个踏板', () => {
    const c = createControls();
    const throttle = document.getElementById('btn-throttle')!;
    const brake = document.getElementById('btn-brake')!;
    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP }]));
    brake.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientY: TRACK_TOP }]));
    c.reset();
    expect(c.getThrottle()).toBe(0);
    expect(c.getBrake()).toBe(0);
  });
});

describe('TouchControls — 机械联动与触觉', () => {
  beforeEach(setupDom);

  it('行程同步到 CSS 变量、油量条、踏板行程与读数', () => {
    const c = createControls();
    const throttle = document.getElementById('btn-throttle')!;
    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP + TRACK_HEIGHT * 0.25 }]));

    const fill = document.getElementById('throttle-bar-fill')!;
    const thumb = document.getElementById('throttle-slider')!;
    const readout = document.getElementById('throttle-readout')!;

    expect(parseFloat(fill.style.height)).toBeCloseTo(75, 1);
    expect(parseFloat(thumb.style.bottom)).toBeCloseTo(75, 1);
    expect(parseFloat(throttle.style.getPropertyValue('--pedal'))).toBeCloseTo(0.75, 3);
    expect(readout.textContent).toBe('75%');
    expect(throttle.dataset.full).toBe('0');
  });

  it('踩到底时标记 data-full 并触发一次触底振动', () => {
    const vibrate = vi.fn().mockReturnValue(true);
    (navigator as unknown as Record<string, unknown>).vibrate = vibrate;

    const haptics = new Haptics();
    const c = createControls(haptics);
    const throttle = document.getElementById('btn-throttle')!;

    throttle.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP }]));
    expect(throttle.dataset.full).toBe('1');
    expect(vibrate).toHaveBeenCalledTimes(1);

    // 持续停在底部不再重复振动
    throttle.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientY: TRACK_TOP }]));
    expect(vibrate).toHaveBeenCalledTimes(1);

    // 松开时给一次回位反馈
    throttle.dispatchEvent(touchEvent('touchend', [{ identifier: 1, clientY: TRACK_TOP }]));
    expect(vibrate).toHaveBeenCalledTimes(2);

    delete (navigator as unknown as Record<string, unknown>).vibrate;
  });

  it('不支持振动时踏板依然正常工作', () => {
    const c = createControls(new Haptics());
    const brake = document.getElementById('btn-brake')!;
    brake.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientY: TRACK_TOP }]));
    expect(c.getBrake()).toBeCloseTo(1, 6);
    expect(brake.dataset.full).toBe('1');
  });
});

describe('TouchControls — 桌面鼠标调试路径', () => {
  beforeEach(setupDom);

  it('按下并拖动鼠标可控制踏板', () => {
    const c = createControls();
    const brake = document.getElementById('btn-brake')!;

    brake.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: TRACK_TOP }));
    expect(c.getBrake()).toBeCloseTo(1, 6);

    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: TRACK_TOP + TRACK_HEIGHT / 2 }));
    expect(c.getBrake()).toBeCloseTo(0.5, 6);

    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(c.getBrake()).toBe(0);
  });
});
