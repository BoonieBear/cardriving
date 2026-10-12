/**
 * 手机控制器端 WebSocket 客户端
 * 负责加入房间、发送操控数据、接收游戏状态
 */
import { BaseWSClient } from './BaseWSClient.js';
import { normalizeDriveMode, type DriveMode } from '../car/AutoPilot.js';
import type {
  JoinRoomResponse,
  ErrorResponse,
  ControlPacket,
  StatePacket,
  DeviceStatusNotification,
  DriveModeNotification,
} from '../../../shared/protocol.js';

export class ControllerClient extends BaseWSClient {
  private roomCode: string = '';
  private statePacketCallback: ((packet: StatePacket) => void) | null = null;
  private joinResultCallback: ((success: boolean, error?: string) => void) | null = null;
  private driveModeCallback: ((mode: DriveMode) => void) | null = null;

  constructor(url?: string) {
    const wsUrl = url || ControllerClient.buildUrl();
    super(wsUrl);

    this.onMessage('room_joined', (data: JoinRoomResponse) => {
      if (data.success) {
        this.roomCode = data.roomCode;
        console.log(`[Controller] 加入房间成功: ${this.roomCode}`);
        if (this.joinResultCallback) {
          this.joinResultCallback(true);
          this.joinResultCallback = null;
        }
      }
    });

    this.onMessage('error', (data: ErrorResponse) => {
      console.error(`[Controller] 错误: ${data.code} - ${data.message}`);
      if (this.joinResultCallback) {
        this.joinResultCallback(false, data.message);
        this.joinResultCallback = null;
      }
    });

    this.onMessage('device_status', (data: DeviceStatusNotification) => {
      // 大屏断开时会收到 connected=false
      console.log(`[Controller] 设备状态: ${data.connected}`);
    });

    // 大屏通知的驾驶模式变更（可能是大屏本地按键切换的）
    this.onMessage('drive_mode', (data: DriveModeNotification) => {
      const mode = normalizeDriveMode((data as { mode?: unknown })?.mode);
      if (this.driveModeCallback) {
        this.driveModeCallback(mode);
      }
    });
  }

  private static buildUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  /**
   * 加入房间
   */
  joinRoom(roomCode: string, secret: string, deviceName?: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.joinResultCallback = (success: boolean, error?: string) => {
        resolve(success);
        if (!success && error) {
          // 错误信息通过回调传出
          this.lastError = error;
        }
      };

      this.send({
        type: 'join_room',
        roomCode,
        secret,
        deviceName: deviceName || this.getDefaultDeviceName(),
      });
    });
  }

  private lastError: string = '';

  getLastError(): string {
    return this.lastError;
  }

  /**
   * 发送操控数据包
   */
  sendControl(packet: ControlPacket): void {
    this.send(packet);
  }

  /**
   * 注册游戏状态回调
   */
  onStatePacket(callback: (packet: StatePacket) => void): void {
    this.statePacketCallback = callback;
  }

  /**
   * 注册驾驶模式变更回调（大屏通知）
   */
  onDriveMode(callback: (mode: DriveMode) => void): void {
    this.driveModeCallback = callback;
  }

  /**
   * 请求大屏切换驾驶模式（低频控制面消息）
   */
  sendDriveMode(mode: DriveMode): void {
    this.send({ type: 'set_drive_mode', mode });
  }

  /** 重写：处理高频数据包（来自大屏的游戏状态） */
  protected onPacket(packet: object): void {
    if (this.statePacketCallback) {
      const p = packet as Partial<StatePacket>;
      if (
        typeof p.speed === 'number' &&
        typeof p.currentGear === 'number' &&
        typeof p.isDrifting === 'boolean'
      ) {
        this.statePacketCallback(p as StatePacket);
      }
    }
  }

  private getDefaultDeviceName(): string {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    return 'Mobile';
  }

  getRoomCode(): string {
    return this.roomCode;
  }
}
