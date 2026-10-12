import { describe, it, expect } from 'vitest';
import { AutoPilot } from './AutoPilot';
import { CarPhysics } from './CarPhysics';
import { createInitialTrack, EndlessTrackGenerator } from '../core/TrackGenerator';

describe('闭环仿真', () => {
  it('全自动驾驶沿无尽赛道行驶 60 秒', () => {
    const car = new CarPhysics();
    const ap = new AutoPilot();
    const { track, generator } = createInitialTrack(20261005);
    car.setTerrainHeight(() => 0);
    car.reset(track.start.x, track.start.z, track.startHeading);

    const tracks: number[] = [];
    const dt = 1/60;
    let maxOff = 0;
    for (let i = 0; i < 60*60; i++) {
      // 赛道延伸
      const near = track.nearestPoint(car.state.x, car.state.z);
      if (track.totalLength - near.distance < 300) {
        for (let k=0;k<2;k++) track.appendPoints(generator.generateNext());
      }
      const inp = ap.compute(car.state, track, 'auto', {steer:0,throttle:0,brake:0,gear:1}, dt, []);
      car.update(inp, dt);
      const n2 = track.nearestPoint(car.state.x, car.state.z);
      maxOff = Math.max(maxOff, n2.distToTrack);
      tracks.push(track.getProgress(car.state.x, car.state.z));
    }
    const st = car.state;
    console.log('RESULT speed=' + car.getSpeedKmh().toFixed(1) + ' maxOffTrack=' + maxOff.toFixed(2) + ' halfWidth=' + track.halfWidth + ' totalLen=' + track.totalLength.toFixed(0));
    expect(maxOff).toBeLessThan(track.halfWidth);
  });

  /**
   * 回归（阶段二漂移物理）：自动巡航不应误触发漂移。
   *
   * 自动驾驶的弯道限速把横向加速度压在约 6 m/s²，远低于正常抓地上限（16 m/s²），
   * 因此整段 60 秒行驶中滑移角应保持接近 0、漂移状态恒为 false。
   * 若漂移模型误判，会导致自动驾驶出现持续侧滑并冲出赛道。
   */
  it('全自动驾驶 60 秒内不会误触发漂移', () => {
    const car = new CarPhysics();
    const ap = new AutoPilot();
    const { track, generator } = createInitialTrack(20261005);
    car.setTerrainHeight(() => 0);
    car.reset(track.start.x, track.start.z, track.startHeading);

    const dt = 1 / 60;
    let driftFrames = 0;
    let maxSlip = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const near = track.nearestPoint(car.state.x, car.state.z);
      if (track.totalLength - near.distance < 300) {
        for (let k = 0; k < 2; k++) track.appendPoints(generator.generateNext());
      }
      const inp = ap.compute(car.state, track, 'auto', { steer: 0, throttle: 0, brake: 0, gear: 1 }, dt, []);
      car.update(inp, dt);
      if (car.state.isDrifting) driftFrames++;
      maxSlip = Math.max(maxSlip, Math.abs(car.state.slipAngle));
    }

    console.log('NO-DRIFT RESULT driftFrames=' + driftFrames + '/3600 maxSlip=' + maxSlip.toFixed(3));
    expect(driftFrames).toBe(0);
    expect(maxSlip).toBeLessThan(0.05);
  });

  /**
   * 回归：「自动驾驶应靠右行驶」
   *
   * 旧实现把前视点取在赛道中心线上（getAimPoint 无横向偏移），
   * 车道保持的目标就是「压在中心线上」，既不符合右行交通，
   * 也让对向空间被长期占用。修复后目标点右移 config.laneOffset。
   */
  it('全自动驾驶全程保持在中心线右侧行驶', () => {
    const car = new CarPhysics();
    const ap = new AutoPilot();
    const { track, generator } = createInitialTrack(20261005);
    car.setTerrainHeight(() => 0);
    car.reset(track.start.x, track.start.z, track.startHeading);

    const dt = 1 / 60;
    let maxOff = 0;
    let sumLateral = 0;
    let samples = 0;
    let leftFrames = 0;

    for (let i = 0; i < 60 * 60; i++) {
      const near = track.nearestPoint(car.state.x, car.state.z);
      if (track.totalLength - near.distance < 300) {
        for (let k = 0; k < 2; k++) track.appendPoints(generator.generateNext());
      }
      const inp = ap.compute(car.state, track, 'auto', { steer: 0, throttle: 0, brake: 0, gear: 1 }, dt, []);
      car.update(inp, dt);

      const n2 = track.nearestPoint(car.state.x, car.state.z);
      maxOff = Math.max(maxOff, n2.distToTrack);
      // Track.nearestPoint 的约定：lateralOffset > 0 表示车在中心线「左侧」
      sumLateral += n2.lateralOffset;
      samples++;
      if (n2.lateralOffset > 0.5) leftFrames++;
    }

    const avgLateral = sumLateral / samples;
    console.log(
      'RIGHT-SIDE RESULT avgLateral=' + avgLateral.toFixed(3) +
      ' (负=在中心线右侧) leftFrames=' + leftFrames + '/' + samples +
      ' maxOffTrack=' + maxOff.toFixed(2),
    );

    // 不能冲出赛道
    expect(maxOff).toBeLessThan(track.halfWidth);
    // 平均位置必须在中心线右侧
    expect(avgLateral).toBeLessThan(0);
    // 绝大多数时间不应偏到左侧
    expect(leftFrames / samples).toBeLessThan(0.1);
  });
});
