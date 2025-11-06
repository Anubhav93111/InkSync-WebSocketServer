import { WebSocketServer, WebSocket } from "ws";
import { PrismaClient } from "../app/generated/prisma/client.js";

const prisma = new PrismaClient();
const PORT = Number(process.env.PORT ?? 3010);

const activeClients = new Map<WebSocket, { userId: number; roomId: string }>();
const roomUserMap = new Map<string, Set<number>>();
const roomShapes = new Map<string, any[]>();

const wss = new WebSocketServer({ port: PORT });
console.log(`🚀 WebSocket server running on port ${PORT}`);

wss.on("connection", (ws: WebSocket) => {
  console.log("🔌 Client connected");
  ws.on("message", async (data: Buffer) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data.toString());
    } catch (err) {
      console.warn('Failed to parse incoming message', err);
      try {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON format" }));
      } catch {}
      return;
    }

    const clientMeta = activeClients.get(ws);

    try {
      switch (parsed.type) {
      case "register": {
        const { roomId, userId } = parsed;
        if (!roomId || !userId) {
          ws.send(JSON.stringify({ type: "error", message: "Missing roomId or userId" }));
          return;
        }

        const numericUserId = Number(userId);
        const room = await prisma.roomId.findUnique({
          where: { id: roomId },
          include: { users: true },
        });

        if (!room || !room.users.some((u) => u.id === numericUserId)) {
          ws.send(JSON.stringify({ type: "error", message: "Unauthorized user or room" }));
          return;
        }

        activeClients.set(ws, { userId: numericUserId, roomId });
        if (!roomUserMap.has(roomId)) roomUserMap.set(roomId, new Set());
        roomUserMap.get(roomId)!.add(numericUserId);

        console.log("✅ Registered user:", numericUserId, "in room:", roomId);
        console.log("🧑‍🤝‍🧑 Current room users:", Array.from(roomUserMap.get(roomId)!));

        ws.send(JSON.stringify({ type: "register-success", roomId, userId: numericUserId }));
        broadcastToRoom(roomId, { type: "user-list", users: Array.from(roomUserMap.get(roomId)!) });
        break;
      }

      case "request-user-list": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }
        const list = Array.from(roomUserMap.get(clientMeta.roomId) || []);
        ws.send(JSON.stringify({ type: "user-list", users: list }));
        break;
      }

      case "message": {
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

        const chat = await prisma.chat.create({
          data: {
            message: text,
            createdAt: new Date(),
            userId: numericUserId,
            roomId,
          },
        });

        ws.send(JSON.stringify({ type: "message-sent", chat }));
        broadcastToRoom(roomId, { type: "new-message", chat }, ws);
        break;
      }

      case "pointer": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
          broadcastToRoom(clientMeta.roomId, { type: "pointer", x: parsed.x, y: parsed.y, color: parsed.color || null, userId: clientMeta.userId }, ws);
        }
        break;
      }

      case "lock": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }
        // broadcast lock state to other clients in the room
        broadcastToRoom(clientMeta.roomId, { type: "lock", lockedBy: clientMeta.userId }, ws);
        break;
      }

      case "unlock": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }
        broadcastToRoom(clientMeta.roomId, { type: "unlock" }, ws);
        break;
      }

      case "color": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }
        if (typeof parsed.color === "string") {
          broadcastToRoom(clientMeta.roomId, { type: "color", color: parsed.color, userId: clientMeta.userId }, ws);
        }
        break;
      }

      case "init":
      case "draw":
      case "stream":
      case "move":
      case "delete":
      case "clear": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }

        const { roomId } = clientMeta;
        const shapes = roomShapes.get(roomId) || [];

        switch (parsed.type) {
          case "init":
            ws.send(JSON.stringify({ type: "init", shapes }));
            break;

          case "clear":
            roomShapes.set(roomId, []);
            broadcastToRoom(roomId, { type: "sync", shapes: [] });
            break;

          case "draw":
            shapes.push(parsed.element);
            roomShapes.set(roomId, shapes);
            broadcastToRoom(roomId, { type: "sync", shapes });
            break;

          case "stream":
            if (typeof parsed.index === "number") {
              shapes[parsed.index] = parsed.element;
              roomShapes.set(roomId, shapes);
              // include any color metadata that came with the stream payload
              broadcastStreamToRoom(roomId, { type: "stream", element: parsed.element, index: parsed.index, color: parsed.color, userId: clientMeta.userId }, ws);
            }
            break;

          case "move":
            if (typeof parsed.index === "number") {
              shapes[parsed.index] = parsed.element;
              roomShapes.set(roomId, shapes);
              broadcastToRoom(roomId, { type: "sync", shapes });
            }
            break;

          case "delete":
            if (typeof parsed.index === "number") {
              shapes.splice(parsed.index, 1);
              roomShapes.set(roomId, shapes);
              broadcastToRoom(roomId, { type: "sync", shapes });
            }
            break;
        }
        break;
      }

      case "webrtc-offer":
      case "webrtc-answer":
      case "webrtc-ice": {
        if (!clientMeta) {
          ws.send(JSON.stringify({ type: "error", message: "Client not registered" }));
          return;
        }

        const { targetUserId, data } = parsed;
        if (!targetUserId) {
          ws.send(JSON.stringify({ type: "error", message: "Missing targetUserId" }));
          return;
        }

        console.log("🔁 Forwarding signaling:", parsed.type, "from", clientMeta.userId, "to", targetUserId);

        const forwarded = sendToUserInRoom(clientMeta.roomId, Number(targetUserId), {
          type: parsed.type,
          fromUserId: clientMeta.userId,
          data,
        });

        if (!forwarded) {
          console.warn("⚠️ Target user not connected:", targetUserId);
          ws.send(JSON.stringify({ type: "error", message: "Target user not connected" }));
        }
        break;
      }

      default:
        try {
          ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
        } catch {}
      }
    } catch (err) {
      console.error('Error handling ws message', err);
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
      } catch {}
    }
  });

  ws.on("close", () => {
    const meta = activeClients.get(ws);
    if (meta) {
      const { roomId, userId } = meta;
      const roomSet = roomUserMap.get(roomId);
      roomSet?.delete(userId);
      if (roomSet?.size === 0) roomUserMap.delete(roomId);
      activeClients.delete(ws);
    }
    console.log("❎ Client disconnected");
  });
});

// Graceful shutdown and Prisma cleanup for production
async function shutdown(signal?: string) {
  console.log('Shutting down server', signal || '');
  try {
    wss.close();
  } catch (e) {
    console.warn('Error closing WebSocket server', e);
  }
  try {
    await prisma.$disconnect();
  } catch (e) {
    console.warn('Error disconnecting Prisma client', e);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  shutdown('unhandledRejection');
});

function broadcastToRoom(roomId: string, payload: any, exclude?: WebSocket) {
  const recipients = roomUserMap.get(roomId);
  const message = JSON.stringify(payload);
  for (const [client, meta] of activeClients.entries()) {
    if (
      client !== exclude &&
      meta.roomId === roomId &&
      recipients?.has(meta.userId) &&
      client.readyState === WebSocket.OPEN
    ) {
      console.log("📡 Broadcasting to user:", meta.userId);
      client.send(message);
    }
  }
}

function sendToUserInRoom(roomId: string, targetUserId: number, payload: any): boolean {
  const message = JSON.stringify(payload);
  for (const [client, meta] of activeClients.entries()) {
    if (
      meta.roomId === roomId &&
      meta.userId === targetUserId &&
      client.readyState === WebSocket.OPEN
    ) {
      console.log("📨 Sending message to user:", targetUserId);
      client.send(message);
      return true;
    }
  }
  console.warn("🚫 Could not find user:", targetUserId, "in room:", roomId);
  return false;
}

function broadcastStreamToRoom(roomId: string, payload: any, sender?: WebSocket) {
  const recipients = roomUserMap.get(roomId);
  const message = JSON.stringify(payload);
  for (const [client, meta] of activeClients.entries()) {
    if (
      client !== sender &&
      meta.roomId === roomId &&
      recipients?.has(meta.userId) &&
      client.readyState === WebSocket.OPEN
    ) {
      client.send(message);
    }
  }
}
