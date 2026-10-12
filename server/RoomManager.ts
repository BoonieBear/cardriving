/**
 * 房间管理器
 * 负责房间创建、加入、校验、连接管理、消息转发
 */
import type { WebSocket } from 'ws';
import { generateRoomCode, isValidRoomCode } from '../shared/utils/randomCode.js';
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  ErrorResponse,
  DeviceStatusNotification,
  RoomInfo,
  ClientRole,
} from '../shared/protocol.js';

/** 附加在 WebSocket 上的元数据 */
export interface ClientMeta {
  role: ClientRole;
  roomCode: string | null;
  deviceName?: string;
  lastHeartbeat: number;
}

/** 房间内部状态 */
interface Room {
  roomCode: string;
  secret: string;
  host: WebSocket | null;
  controller: WebSocket | null;
  controllerName?: string;
  createdAt: number;
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private clientMeta: WeakMap<WebSocket, ClientMeta> = new WeakMap();

  /**
   * 大屏创建房间
   */
  createRoom(secret: string, hostWs: WebSocket): CreateRoomResponse | ErrorResponse {
    // 密钥校验
    if (!secret || secret.length < 1) {
      return {
        type: 'error',
        code: 'INVALID_SECRET',
        message: '密钥不能为空',
      };
    }
    if (secret.length > 32) {
      return {
        type: 'error',
        code: 'INVALID_SECRET',
        message: '密钥长度不能超过32个字符',
      };
    }

    // 如果该 host 已有房间，先关闭旧房间
    const oldMeta = this.clientMeta.get(hostWs);
    if (oldMeta?.roomCode) {
      this.closeRoom(oldMeta.roomCode);
    }

    // 生成不重复的6位房间码
    let roomCode: string;
    let attempts = 0;
    do {
      roomCode = generateRoomCode();
      attempts++;
    } while (this.rooms.has(roomCode) && attempts < 100);

    if (this.rooms.has(roomCode)) {
      return {
        type: 'error',
        code: 'ROOM_CODE_EXHAUSTED',
        message: '房间码生成失败，请重试',
      };
    }

    const room: Room = {
      roomCode,
      secret,
      host: hostWs,
      controller: null,
      createdAt: Date.now(),
    };

    this.rooms.set(roomCode, room);
    this.clientMeta.set(hostWs, {
      role: 'host',
      roomCode,
      lastHeartbeat: Date.now(),
    });

    console.log(`[Room] 房间创建成功: ${roomCode}, host已绑定`);

    return {
      type: 'room_created',
      roomCode,
      secret,
    };
  }

  /**
   * 手机加入房间
   */
  joinRoom(
    roomCode: string,
    secret: string,
    controllerWs: WebSocket,
    deviceName?: string
  ): JoinRoomResponse | ErrorResponse {
    // 校验房间码格式
    if (!isValidRoomCode(roomCode)) {
      return {
        type: 'error',
        code: 'INVALID_ROOM_CODE',
        message: '房间码必须是6位数字',
      };
    }

    const room = this.rooms.get(roomCode);
    if (!room) {
      return {
        type: 'error',
        code: 'ROOM_NOT_FOUND',
        message: '房间不存在',
      };
    }

    // 校验密钥
    if (room.secret !== secret) {
      return {
        type: 'error',
        code: 'WRONG_SECRET',
        message: '密钥错误',
      };
    }

    // 检查大屏是否在线
    if (!room.host || room.host.readyState !== room.host.OPEN) {
      return {
        type: 'error',
        code: 'HOST_OFFLINE',
        message: '大屏主机未在线',
      };
    }

    // 如果已有控制器连接，先断开旧的（单房间单控制器）
    if (room.controller && room.controller.readyState === room.controller.OPEN) {
      this.notifyDeviceStatus(room.controller, false);
      room.controller.close(4000, 'Replaced by new controller');
    }

    // 绑定控制器
    room.controller = controllerWs;
    room.controllerName = deviceName;
    this.clientMeta.set(controllerWs, {
      role: 'controller',
      roomCode,
      deviceName,
      lastHeartbeat: Date.now(),
    });

    console.log(`[Room] 控制器加入房间: ${roomCode}, 设备: ${deviceName || '未知'}`);

    // 通知大屏：控制器已连接
    this.notifyDeviceStatus(room.host, true, deviceName);

    return {
      type: 'room_joined',
      roomCode,
      success: true,
    };
  }

  /**
   * 处理客户端断开
   */
  handleDisconnect(ws: WebSocket): void {
    const meta = this.clientMeta.get(ws);
    if (!meta || !meta.roomCode) return;

    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    if (meta.role === 'host') {
      // 大屏断开：通知控制器，然后关闭房间
      console.log(`[Room] 大屏断开，关闭房间: ${meta.roomCode}`);
      if (room.controller && room.controller.readyState === room.controller.OPEN) {
        this.notifyDeviceStatus(room.controller, false);
        room.controller.close(4001, 'Host disconnected');
      }
      this.closeRoom(meta.roomCode);
    } else if (meta.role === 'controller') {
      // 控制器断开：通知大屏，保留房间
      console.log(`[Room] 控制器断开: ${meta.roomCode}`);
      room.controller = null;
      if (room.host && room.host.readyState === room.host.OPEN) {
        this.notifyDeviceStatus(room.host, false);
      }
    }
  }

  /**
   * 转发高频数据包
   * 控制器 -> 大屏：ControlPacket
   * 大屏 -> 控制器：StatePacket
   */
  forwardPacket(ws: WebSocket, data: object): void {
    const meta = this.clientMeta.get(ws);
    if (!meta || !meta.roomCode) return;

    const room = this.rooms.get(meta.roomCode);
    if (!room) return;

    const json = JSON.stringify(data);

    if (meta.role === 'controller') {
      // 控制器 -> 大屏
      if (room.host && room.host.readyState === room.host.OPEN) {
        room.host.send(json);
      }
    } else if (meta.role === 'host') {
      // 大屏 -> 控制器
      if (room.controller && room.controller.readyState === room.controller.OPEN) {
        room.controller.send(json);
      }
    }
  }

  /**
   * 更新心跳时间
   */
  updateHeartbeat(ws: WebSocket): void {
    const meta = this.clientMeta.get(ws);
    if (meta) {
      meta.lastHeartbeat = Date.now();
    }
  }

  /**
   * 获取客户端元数据
   */
  getMeta(ws: WebSocket): ClientMeta | undefined {
    return this.clientMeta.get(ws);
  }

  /**
   * 获取房间信息
   */
  getRoomInfo(roomCode: string): RoomInfo | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    return {
      roomCode: room.roomCode,
      secret: room.secret,
      hostConnected: !!room.host && room.host.readyState === room.host.OPEN,
      controllerConnected: !!room.controller && room.controller.readyState === room.controller.OPEN,
      createdAt: room.createdAt,
    };
  }

  /**
   * 获取所有房间数量
   */
  getRoomCount(): number {
    return this.rooms.size;
  }

  // ========== 私有方法 ==========

  private closeRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (room.host && room.host.readyState === room.host.OPEN) {
      room.host.close(4002, 'Room closed');
    }
    if (room.controller && room.controller.readyState === room.controller.OPEN) {
      room.controller.close(4002, 'Room closed');
    }

    this.rooms.delete(roomCode);
    console.log(`[Room] 房间已关闭: ${roomCode}`);
  }

  private notifyDeviceStatus(ws: WebSocket, connected: boolean, deviceName?: string): void {
    const notification: DeviceStatusNotification = {
      type: 'device_status',
      connected,
      deviceName,
    };
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(notification));
    }
  }
}
