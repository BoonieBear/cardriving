/**
 * 大屏主机端 WebSocket 客户端
 * 负责创建房间、接收控制器操控数据、发送游戏状态
 */
import { BaseWSClient } from './BaseWSClient.js';
import { normalizeDriveMode, type DriveMode } from '../car/AutoPilot.js';
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  ErrorResponse,
  ControlPacket,
  StatePacket,
  DeviceStatusNotification,
  DriveModeRequest,
} from '../../../shared/protocol.js';

export class HostClient extends BaseWSClient {
  private roomCode: string = '';
  private secret: string = '';
  private controllerConnected: boolean = false;
  private controlPacketCallback: ((packet: ControlPacket) => void) | null = null;
  private deviceStatusCallback: ((connected: boolean, deviceName?: string) => void) | null = null;
  private driveModeCallback: ((mode: DriveMode) => void) | null = null;

  constructor(url?: string) {
    const wsUrl = url || HostClient.buildUrl();
    super(wsUrl);

    this.onMessage('room_created', (data: CreateRoomResponse) => {
      this.roomCode = data.roomCode;
      this.secret = data.secret;
      console.log(`[Host] 房间创建成功: ${this.roomCode}`);
    });

    this.onMessage('device_status', (data: DeviceStatusNotification) => {
      this.controllerConnected = data.connected;
      console.log(`[Host] 控制器状态: ${data.connected ? '已连接' : '已断开'}`);
      if (this.deviceStatusCallback) {
        this.deviceStatusCallback(data.connected, data.deviceName);
      }
    });

    // 手机端远程请求切换驾驶模式
    this.onMessage('set_drive_mode', (data: DriveModeRequest) => {
      const mode = normalizeDriveMode((data as { mode?: unknown })?.mode);
      console.log(`[Host] 收到手机端驾驶模式请求: ${mode}`);
      if (this.driveModeCallback) {
        this.driveModeCallback(mode);
      }
    });

    this.onMessage('error', (data: ErrorResponse) => {
      console.error(`[Host] 服务器错误: ${data.code} - ${data.message}`);
    });
  }

  /**
   * 构建 WebSocket URL
   * 开发环境通过 Vite 代理 /ws，生产环境用当前 host
   */
  private static buildUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 开发模式下 Vite 代理 /ws 到后端 8787
    // 生产模式下需要 WebSocket 和页面同源
    return `${protocol}//${window.location.host}/ws`;
  }

  /**
   * 创建房间
   */
  createRoom(secret: string): void {
    this.secret = secret;
    this.send({
      type: 'create_room',
      secret,
    });
  }

  /**
   * 发送游戏状态到控制器
   */
  sendState(state: StatePacket): void {
    if (this.controllerConnected) {
      this.send(state);
    }
  }

  /**
   * 注册操控数据包回调
   */
  onControlPacket(callback: (packet: ControlPacket) => void): void {
    this.controlPacketCallback = callback;
  }

  /**
   * 注册控制器连接状态回调
   */
  onDeviceStatus(callback: (connected: boolean, deviceName?: string) => void): void {
    this.deviceStatusCallback = callback;
  }

  /**
   * 注册驾驶模式请求回调（手机端远程切换）
   */
  onDriveModeRequest(callback: (mode: DriveMode) => void): void {
    this.driveModeCallback = callback;
  }

  /**
   * 通知控制器当前驾驶模式
   */
  sendDriveMode(mode: DriveMode): void {
    if (!this.controllerConnected) return;
    this.send({ type: 'drive_mode', mode });
  }

  /** 重写：处理高频数据包（来自控制器的操控数据） */
  protected onPacket(packet: object): void {
    if (this.controlPacketCallback) {
      // 验证字段完整性
      const p = packet as Partial<ControlPacket>;
      if (
        typeof p.steer === 'number' &&
        typeof p.throttle === 'number' &&
        typeof p.brake === 'number' &&
        typeof p.gear === 'number'
      ) {
        this.controlPacketCallback(p as ControlPacket);
      }
    }
  }

  getRoomCode(): string {
    return this.roomCode;
  }

  getSecret(): string {
    return this.secret;
  }

  isControllerConnected(): boolean {
    return this.controllerConnected;
  }
}
