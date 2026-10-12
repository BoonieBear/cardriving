/**
 * WebSocket 后端服务入口
 * 负责房间管理、消息转发、连接维护
 */
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager.js';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8787;
const HEARTBEAT_INTERVAL = 30000; // 30秒心跳检测
const HEARTBEAT_TIMEOUT = 60000; // 60秒无心跳则断开
const roomManager = new RoomManager();
// ========== HTTP 服务器（健康检查 + Vite 代理目标）==========
const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            rooms: roomManager.getRoomCount(),
            uptime: process.uptime(),
        }));
        return;
    }
    res.writeHead(404);
    res.end('Not Found');
});
// ========== WebSocket 服务器 ==========
const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
});
console.log('========================================');
console.log('  WebCarSim WebSocket Server');
console.log('  阶段一：核心底座');
console.log('========================================');
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    console.log(`[WS] 新连接来自: ${clientIp}`);
    ws.on('message', (rawData) => {
        let data;
        try {
            data = JSON.parse(rawData.toString());
        }
        catch {
            // 非 JSON 数据，丢弃
            return;
        }
        // 更新心跳
        roomManager.updateHeartbeat(ws);
        // 判断消息类型
        if (data && typeof data.type === 'string') {
            // 控制面消息
            handleControlMessage(ws, data);
        }
        else {
            // 高频数据包（无 type 字段），直接转发
            roomManager.forwardPacket(ws, data);
        }
    });
    ws.on('close', (code, reason) => {
        console.log(`[WS] 连接断开: ${clientIp}, code=${code}, reason=${reason.toString()}`);
        roomManager.handleDisconnect(ws);
    });
    ws.on('error', (err) => {
        console.error(`[WS] 连接错误: ${clientIp}, ${err.message}`);
    });
});
/**
 * 处理控制面消息
 */
function handleControlMessage(ws, data) {
    switch (data.type) {
        case 'create_room': {
            const req = data;
            const result = roomManager.createRoom(req.secret, ws);
            sendMessage(ws, result);
            break;
        }
        case 'join_room': {
            const req = data;
            const result = roomManager.joinRoom(req.roomCode, req.secret, ws, req.deviceName);
            sendMessage(ws, result);
            break;
        }
        case 'heartbeat': {
            // 心跳已在 message 事件中更新时间，这里回显
            const hb = {
                type: 'heartbeat',
                timestamp: Date.now(),
            };
            sendMessage(ws, hb);
            break;
        }
        case 'set_drive_mode': {
            // 手机端请求切换驾驶模式 → 转发给大屏主机端（反向转发）
            const req = data;
            roomManager.forwardPacket(ws, {
                type: 'set_drive_mode',
                mode: req.mode,
            });
            break;
        }
        default: {
            const err = {
                type: 'error',
                code: 'UNKNOWN_MESSAGE',
                message: `未知消息类型: ${data.type}`,
            };
            sendMessage(ws, err);
        }
    }
}
/**
 * 安全发送消息
 */
function sendMessage(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    }
}
// ========== 心跳检测定时器 ==========
setInterval(() => {
    const now = Date.now();
    // 遍历所有连接检查心跳（通过 wss.clients）
    for (const client of wss.clients) {
        const meta = roomManager.getMeta(client);
        if (meta && now - meta.lastHeartbeat > HEARTBEAT_TIMEOUT) {
            console.log(`[WS] 心跳超时，断开连接: role=${meta.role}, room=${meta.roomCode}`);
            client.close(4003, 'Heartbeat timeout');
        }
    }
}, HEARTBEAT_INTERVAL);
// ========== 启动服务器 ==========
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] HTTP 健康检查: http://localhost:${PORT}/health`);
    console.log(`[Server] WebSocket:       ws://localhost:${PORT}/ws`);
    console.log(`[Server] 等待客户端连接...`);
});
// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n[Server] 正在关闭...');
    wss.close();
    httpServer.close();
    process.exit(0);
});
//# sourceMappingURL=index.js.map