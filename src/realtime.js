import { Server } from "socket.io";
import { isValidOrdersKey } from "./lib/auth.js";
import { onOrderUpdate } from "./lib/events.js";

const orderRoom = (id) => `order:${id}`;
const userRoom = (id) => `user:${id}`;

function roomsFor({ orderId, externalUserId } = {}) {
  const rooms = [];
  if (typeof orderId === "string" && orderId) rooms.push(orderRoom(orderId));
  if (typeof externalUserId === "string" && externalUserId) rooms.push(userRoom(externalUserId));
  return rooms;
}

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: "*" } });

  io.use((socket, next) => {
    const key = socket.handshake.auth?.apiKey ?? socket.handshake.headers["x-api-key"];
    if (!isValidOrdersKey(key)) return next(new Error("invalid api key"));
    next();
  });

  io.on("connection", (socket) => {
    socket.on("subscribe", (filter, ack) => {
      const rooms = roomsFor(filter);
      if (!rooms.length) return ack?.({ ok: false, message: "pass orderId or externalUserId" });
      socket.join(rooms);
      ack?.({ ok: true, rooms });
    });

    socket.on("unsubscribe", (filter, ack) => {
      const rooms = roomsFor(filter);
      rooms.forEach((room) => socket.leave(room));
      ack?.({ ok: true, rooms });
    });
  });

  const stopListening = onOrderUpdate((order) => {
    // chained .to() is a union: a socket in both rooms still gets the event once
    let target = io.to(orderRoom(order.id));
    if (order.externalUserId) target = target.to(userRoom(order.externalUserId));
    target.emit("order:update", order);
  });

  return {
    io,
    close: () => {
      stopListening();
      return io.close();
    },
  };
}
