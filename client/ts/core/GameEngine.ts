/**
 * 游戏引擎（软件3D版）
 * 主循环、帧率统计、整合软件3D渲染器/车辆物理/赛道/技能系统/小地图
 */
import { Software3DRenderer, type CameraMode } from './Software3DRenderer.js';
import { CarPhysics } from '../car/CarPhysics.js';
import { AutoPilot, resolveActiveDriveMode, type DriveMode } from '../car/AutoPilot.js';
import { createInitialTrack, EndlessTrackGenerator } from './TrackGenerator.js';
import type { Track } from './Track.js';
import { SkillSystem } from './SkillSystem.js';
import { Minimap } from './Minimap.js';
import type { ControlPacket, StatePacket } from '../../../shared/protocol.js';

export class GameEngine {
  private renderer: Software3DRenderer;
  private carPhysics: CarPhysics;
  private track: Track;
  private trackGenerator: EndlessTrackGenerator;
  private skillSystem: SkillSystem;
  private minimap: Minimap;
  private autoPilot: AutoPilot;

  private animationFrameId: number = 0;
  private lastTime: number = 0;
  private running: boolean = false;

  // 帧率统计
  private frameCount: number = 0;
  private fpsTimer: number = 0;
  private currentFps: number = 0;

  // 当前输入（来自网络或本地键盘）
  private currentInput: ControlPacket = {
    steer: 0,
    throttle: 0,
    brake: 0,
    gear: 1,
  };

  // 断线接管：控制器断开时由全自动驾驶接手
  private disconnected: boolean = false;
  /** 断线接管前玩家所处的驾驶模式，重连后恢复 */
  private preDisconnectMode: DriveMode = 'manual';

  // 驾驶模式（手动 / 辅助驾驶 / 全自动驾驶）
  private driveMode: DriveMode = 'manual';

  // 状态回调
  private fpsCallback: ((fps: number) => void) | null = null;
  private stateCallback: ((state: StatePacket) => void) | null = null;
  private driveModeCallback: ((mode: DriveMode) => void) | null = null;

  constructor(canvasContainer: HTMLElement) {
    this.renderer = new Software3DRenderer(canvasContainer);
    this.carPhysics = new CarPhysics();
    this.autoPilot = new AutoPilot();
    const { track, generator } = createInitialTrack(20261005);
    this.track = track;
    this.trackGenerator = generator;
    this.skillSystem = new SkillSystem();
    this.minimap = new Minimap(canvasContainer);

    // 地形高度 → 物理（坡度重力）
    this.carPhysics.setTerrainHeight((x, z) => this.renderer.terrainHeight(x, z));

    // 把车放到赛道起点
    this.carPhysics.reset(
      this.track.start.x,
      this.track.start.z,
      this.track.startHeading,
    );

    // 生成技能道具
    this.skillSystem.spawnOnTrack(this.track, this.track.totalLength, 8);

    // 沿赛道两侧生成路边物体
    this.renderer.generateObjectsAlongTrack(this.track, this.track.totalLength);

    // 从渲染器获取路边物体作为碰撞障碍物
    this.updateObstacles();
  }

  /**
   * 检查是否需要扩展赛道，车距末端 < 300米时追加2段
   */
  private checkTrackExtension(): void {
    const state = this.carPhysics.state;
    const near = this.track.nearestPoint(state.x, state.z);
    const distToEnd = this.track.totalLength - near.distance;

    if (distToEnd < 300) {
      const oldLength = this.track.totalLength;
      // 追加2段新赛道
      for (let i = 0; i < 2; i++) {
        const newPts = this.trackGenerator.generateNext();
        this.track.appendPoints(newPts);
      }
      // 在新赛道段上增量生成物体和技能道具
      this.renderer.appendObjectsAlongTrack(this.track, oldLength, this.track.totalLength);
      this.skillSystem.extendOnTrack(this.track, oldLength, this.track.totalLength, 3);
      this.updateObstacles();
    }
  }

  /**
   * 从渲染器的路边物体生成碰撞障碍物
   */
  private updateObstacles(): void {
    const objects = this.renderer.getObjects();
    const obstacles = objects.map(obj => ({
      x: obj.x,
      z: obj.z,
      radius: obj.type === 'tree' ? 1.2 : obj.type === 'rock' ? 1.0 : 0.6,
    }));
    this.carPhysics.setObstacles(obstacles);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
    console.log('[Engine] 游戏循环已启动（软件3D模式）');
  }

  stop(): void {
    this.running = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.animationFrameId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    // 帧率统计
    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.currentFps = Math.round(this.frameCount / this.fpsTimer);
      this.frameCount = 0;
      this.fpsTimer = 0;
      if (this.fpsCallback) this.fpsCallback(this.currentFps);
    }

    const state = this.carPhysics.state;

    // 驾驶模式：手动 / 辅助驾驶 / 全自动驾驶
    // 技能道具的临时自动驾驶效果并入「辅助驾驶」档位处理；
    // 控制器断开时由「全自动驾驶」接管（不再缓缓停车）。
    const activeMode = resolveActiveDriveMode({
      driveMode: this.driveMode,
      hasAutoDriveSkill: this.skillSystem.hasAutoDrive(),
      disconnected: this.disconnected,
    });

    let effectiveInput: ControlPacket;
    if (activeMode === 'manual') {
      effectiveInput = { ...this.currentInput };
      this.carPhysics.setSpeedLimit(null);
    } else {
      effectiveInput = this.autoPilot.compute(
        state,
        this.track,
        activeMode,
        this.currentInput,
        dt,
        this.carPhysics.getObstacles(),
      );
      // 弯道/避障限速通过外部限速下发给物理系统
      const cornerLimit = activeMode === 'auto'
        ? this.autoPilot.getCornerSpeedLimit(
            this.track,
            this.track.nearestPoint(state.x, state.z).distance,
            state.speed,
          )
        : null;
      this.carPhysics.setSpeedLimit(cornerLimit);
    }

    // 加速技能：增强油门
    if (this.skillSystem.hasNitro()) {
      effectiveInput = {
        ...effectiveInput,
        throttle: Math.min(1, effectiveInput.throttle * 1.5 + 0.3),
      };
    }

    // 更新物理
    this.carPhysics.update(effectiveInput, dt);

    // 更新技能系统（碰撞检测、计时）
    this.skillSystem.update(state.x, state.z, dt);

    // 检查是否需要扩展赛道（无尽生成）
    this.checkTrackExtension();

    // 渲染
    this.renderer.render(
      state.x, state.z, state.heading,
      state.speed, state.steerAngle, state.isDrifting, dt,
      this.track, this.skillSystem,
      state.driftIntensity, state.slipAngle,
    );

    // 小地图
    this.minimap.render(this.track, state.x, state.z, state.heading, this.skillSystem);

    // 状态同步
    if (this.stateCallback) {
      const outState: StatePacket = {
        speed: this.carPhysics.getSpeedKmh(),
        currentGear: this.carPhysics.state.currentGear,
        isDrifting: this.carPhysics.state.isDrifting,
        connectState: 'connected',
        // 断开接管期间对外报告 auto，让手机/大屏 HUD 与实际接管状态一致
        driveMode: this.getEffectiveDriveMode(),
      };
      this.stateCallback(outState);
    }
  };

  /**
   * 计算自动驾驶输入：沿赛道中心线行驶
   * （保留旧接口，内部委托给 AutoPilot，等价于「辅助驾驶」档）
   */
  computeAutoDriveInput(x: number, z: number, heading: number): ControlPacket {
    return this.autoPilot.compute(
      { ...this.carPhysics.state, x, z, heading },
      this.track,
      'assist',
      this.currentInput,
      1 / 60,
      this.carPhysics.getObstacles(),
    );
  }

  // ========== 驾驶模式 ==========

  /**
   * 切换驾驶模式（手动 / 辅助驾驶 / 全自动驾驶）
   */
  setDriveMode(mode: DriveMode): void {
    // 断开接管期间玩家改模式：只更新「重连后要恢复的模式」，
    // 不打断当前的自动驾驶接管。
    if (this.disconnected) {
      this.preDisconnectMode = mode;
      return;
    }
    if (mode === this.driveMode) return;
    this.driveMode = mode;
    // 切换时清空自动驾驶的平滑量与挡位记忆，避免上一模式的残留
    this.autoPilot.reset(this.carPhysics.state.currentGear);
    this.carPhysics.setSpeedLimit(null);
    console.log(`[Engine] 驾驶模式切换为: ${mode}`);
    if (this.driveModeCallback) this.driveModeCallback(mode);
  }

  getDriveMode(): DriveMode {
    return this.driveMode;
  }

  /** 循环切换驾驶模式（键盘 M 键 / 模式按钮用） */
  cycleDriveMode(): DriveMode {
    const next: DriveMode =
      this.driveMode === 'manual' ? 'assist'
      : this.driveMode === 'assist' ? 'auto'
      : 'manual';
    this.setDriveMode(next);
    return next;
  }

  /** 是否处于系统接管状态（辅助驾驶或全自动驾驶） */
  isAutonomous(): boolean {
    return this.driveMode !== 'manual';
  }

  onDriveModeChange(callback: (mode: DriveMode) => void): void {
    this.driveModeCallback = callback;
  }

  // ========== 相机视角（阶段二）==========

  /** 切换相机视角（第一人称车内 / 车尾跟随 / 上帝俯视） */
  setCameraMode(mode: CameraMode): void {
    this.renderer.setCameraMode(mode);
  }

  /** 当前相机视角 */
  getCameraMode(): CameraMode {
    return this.renderer.getCameraMode();
  }

  /** 循环切换相机视角（快捷键 C 用），返回切换后的视角 */
  cycleCameraView(): CameraMode {
    return this.renderer.cycleCameraView();
  }

  getAutoPilot(): AutoPilot {
    return this.autoPilot;
  }

  setInput(input: ControlPacket): void {
    this.currentInput = { ...input };
  }

  /**
   * 控制器断开：交出控制权给全自动驾驶。
   *
   * 与旧行为（coastToStop 缓缓停车）不同，这里让车辆继续正常行驶，
   * 避免在赛道中间停车造成后车/道具逻辑异常，也符合「掉线不失控」的预期。
   * 幂等：重复调用不会覆盖已保存的玩家模式。
   */
  enterDisconnectTakeover(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    // 记下玩家原本选的模式，重连后原样恢复
    this.preDisconnectMode = this.driveMode;
    // 清空残留输入，避免断开瞬间仍带着上一帧的油门/转向
    this.currentInput = { steer: 0, throttle: 0, brake: 0, gear: this.carPhysics.state.currentGear };
    // 重置自动驾驶的平滑量与挡位记忆，接管从干净状态开始
    this.autoPilot.reset(this.carPhysics.state.currentGear);
    this.carPhysics.setSpeedLimit(null);
    console.log('[Engine] 控制器断开，已切换为全自动驾驶接管');
    if (this.driveModeCallback) this.driveModeCallback('auto');
  }

  /**
   * 控制器重连：结束接管，恢复玩家断开前的驾驶模式。
   */
  exitDisconnectTakeover(): void {
    if (!this.disconnected) return;
    this.disconnected = false;
    const restore = this.preDisconnectMode;
    this.preDisconnectMode = 'manual';
    console.log(`[Engine] 控制器重连，恢复驾驶模式: ${restore}`);
    this.setDriveMode(restore);
  }

  /** 控制器是否处于断开接管状态 */
  isDisconnected(): boolean {
    return this.disconnected;
  }

  /** 断开接管期间对外显示的驾驶模式（用于 UI/HUD） */
  getEffectiveDriveMode(): DriveMode {
    return this.disconnected ? 'auto' : this.driveMode;
  }

  resetCar(): void {
    this.carPhysics.reset(
      this.track.start.x,
      this.track.start.z,
      this.track.startHeading,
    );
  }

  onFpsUpdate(callback: (fps: number) => void): void {
    this.fpsCallback = callback;
  }

  onStateUpdate(callback: (state: StatePacket) => void): void {
    this.stateCallback = callback;
  }

  getFps(): number {
    return this.currentFps;
  }

  getCarPhysics(): CarPhysics {
    return this.carPhysics;
  }

  getCurrentInput(): ControlPacket {
    return { ...this.currentInput };
  }

  getTrack(): Track {
    return this.track;
  }

  getSkillSystem(): SkillSystem {
    return this.skillSystem;
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
    this.minimap.dispose();
  }
}
