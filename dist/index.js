import { WebSocketServer, WebSocket } from "ws";
import { PrismaClient } from "../app/generated/prisma/client.js";
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3010);
const activeClients = new Map();
const roomUserMap = new Map();
const roomShapes = new Map(); // roomId → shapes[]
let wss;
try {
    wss = new WebSocketServer({ port: PORT });
}
catch (err) {
    console.error(`Failed to start WebSocket server on port ${PORT}:`, err?.message ?? err);
    process.exit(1);
}
// extra safety: handle runtime errors emitted by the server
wss.on("error", (err) => {
    console.error("WebSocket server error:", err);
    if (err?.code === "EADDRINUSE") {
        console.error(`Port ${PORT} is already in use. If you intended to run another instance, stop it or set PORT to a different value.`);
        process.exit(1);
    }
});
wss.on("connection", (ws) => {
    console.log("🔌 Client connected");
    ws.on("message", async (data) => {
        try {
            const raw = data.toString();
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch (err) {
                ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
                return;
            }
            // 🧾 Register client
            if (parsed.type === "register") {
                const { roomId, userId } = parsed;
                if (!roomId || !userId) {
                    ws.send(JSON.stringify({ type: "error", message: "Missing roomId or userId" }));
                    return;
                }
                const numericUserId = Number(userId);
                let room;
                try {
                    room = await prisma.roomId.findUnique({
                        where: { id: roomId },
                        include: { users: true },
                    });
                }
                catch {
                    ws.send(JSON.stringify({ type: "error", message: "Database error during room lookup" }));
                    return;
                }
                if (!room || !room.users.some((u) => u.id === numericUserId)) {
                    ws.send(JSON.stringify({ type: "error", message: "Unauthorized user or room" }));
                    return;
                }
                activeClients.set(ws, { userId: numericUserId, roomId });
                if (!roomUserMap.has(roomId))
                    roomUserMap.set(roomId, new Set());
                roomUserMap.get(roomId).add(numericUserId);
                ws.send(JSON.stringify({ type: "register-success", roomId, userId: numericUserId }));
                // broadcast updated user list to room
                const list = Array.from(roomUserMap.get(roomId) || []);
                broadcastToRoom(roomId, { type: 'user-list', users: list });
                return;
            }
            // 💬 Handle chat message
            if (parsed.type === "message") {
                const clientMeta = activeClients.get(ws);
                if (!clientMeta) {
                    ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
                    return;
                }
                const { roomId, user_id, text } = parsed;
                const numericUserId = Number(user_id);
                if (roomId !== clientMeta.roomId || numericUserId !== clientMeta.userId) {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid room or user context" }));
                    return;
                }
                let chat;
                try {
                    chat = await prisma.chat.create({
                        data: {
                            message: text,
                            createdAt: new Date(),
                            userId: numericUserId,
                            roomId,
                        },
                    });
                }
                catch {
                    ws.send(JSON.stringify({ type: "error", message: "Failed to save message" }));
                    return;
                }
                ws.send(JSON.stringify({ type: "message-sent", chat }));
                broadcastToRoom(roomId, { type: "new-message", chat }, ws);
                return;
            }
            // 🎨 Drawing Events
            if (["init", "draw", "stream", "move", "delete", "clear"].includes(parsed.type)) {
                const clientMeta = activeClients.get(ws);
                if (!clientMeta) {
                    ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
                    return;
                }
                const { roomId } = clientMeta;
                const shapes = roomShapes.get(roomId) || [];
                if (parsed.type === "init") {
                    ws.send(JSON.stringify({ type: "init", shapes }));
                    return;
                }
                if (parsed.type === "clear") {
                    roomShapes.set(roomId, []);
                    broadcastToRoom(roomId, { type: "sync", shapes: [] });
                    return;
                }
                if (parsed.type === "draw" && parsed.element) {
                    shapes.push(parsed.element);
                    roomShapes.set(roomId, shapes);
                    broadcastToRoom(roomId, { type: "sync", shapes });
                    return;
                }
                if (parsed.type === "stream" && parsed.element && typeof parsed.index === "number") {
                    shapes[parsed.index] = parsed.element;
                    roomShapes.set(roomId, shapes);
                    broadcastStreamToRoom(roomId, parsed.element, parsed.index, ws);
                    return;
                }
                if (parsed.type === "move" && parsed.element && typeof parsed.index === "number") {
                    shapes[parsed.index] = parsed.element;
                    roomShapes.set(roomId, shapes);
                    broadcastToRoom(roomId, { type: "sync", shapes });
                    return;
                }
                if (parsed.type === "delete" && typeof parsed.index === "number") {
                    shapes.splice(parsed.index, 1);
                    roomShapes.set(roomId, shapes);
                    broadcastToRoom(roomId, { type: "sync", shapes });
                    return;
                }
            }
            // --- WebRTC signaling messages ---
            if (parsed.type === 'webrtc-offer' || parsed.type === 'webrtc-answer' || parsed.type === 'webrtc-ice') {
                // payload should contain: targetUserId and data
                const clientMeta = activeClients.get(ws);
                if (!clientMeta) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Client not registered' }));
                    return;
                }
                const { targetUserId, data } = parsed;
                if (!targetUserId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Missing targetUserId' }));
                    return;
                }
                const forwarded = sendToUserInRoom(clientMeta.roomId, Number(targetUserId), {
                    type: parsed.type,
                    fromUserId: clientMeta.userId,
                    data,
                });
                if (!forwarded) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Target user not connected' }));
                }
                return;
            }
            if (parsed.type === 'request-user-list') {
                const clientMeta = activeClients.get(ws);
                if (!clientMeta) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Client not registered' }));
                    return;
                }
                const list = Array.from(roomUserMap.get(clientMeta.roomId) || []);
                ws.send(JSON.stringify({ type: 'user-list', users: list }));
                return;
            }
        }
        catch (err) {
            ws.send(JSON.stringify({ type: "error", message: "Unexpected server error" }));
        }
    });
    ws.on("close", () => {
        const meta = activeClients.get(ws);
        if (meta) {
            const { roomId, userId } = meta;
            const roomSet = roomUserMap.get(roomId);
            if (roomSet) {
                roomSet.delete(userId);
                if (roomSet.size === 0)
                    roomUserMap.delete(roomId);
            }
        }
        activeClients.delete(ws);
        console.log("❎ Client disconnected");
    });
});
function broadcastToRoom(roomId, payload, exclude) {
    const recipients = roomUserMap.get(roomId);
    const message = JSON.stringify(payload);
    for (const [client, meta] of activeClients.entries()) {
        if (client !== exclude &&
            meta.roomId === roomId &&
            recipients?.has(meta.userId) &&
            client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}
function sendToUserInRoom(roomId, targetUserId, payload) {
    const message = JSON.stringify(payload);
    for (const [client, meta] of activeClients.entries()) {
        if (meta.roomId === roomId && meta.userId === targetUserId && client.readyState === WebSocket.OPEN) {
            client.send(message);
            return true;
        }
    }
    return false;
}
function broadcastStreamToRoom(roomId, element, index, sender) {
    const recipients = roomUserMap.get(roomId);
    const message = JSON.stringify({ type: "stream", element, index });
    for (const [client, meta] of activeClients.entries()) {
        if (client !== sender &&
            meta.roomId === roomId &&
            recipients?.has(meta.userId) &&
            client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}
console.log(`🚀 WebSocket server running on ws://localhost:${PORT}`);
//# sourceMappingURL=index.js.map