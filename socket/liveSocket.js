import jwt from "jsonwebtoken";

export const setupLiveSocket = (io) => {
  const streamers      = new Map(); // liveId → socketId
  const pendingViewers = new Map(); // liveId → Set<socketId>
  const iceCandidateQueues = new Map();

  // liveId → Map<socketId, { name, joinedAt }>
  const viewerRegistry = new Map();

  // liveId → boolean (¿puede el viewer compartir?)
  const shareEnabled = new Map();

  const broadcastViewerList = (liveId) => {
    const reg = viewerRegistry.get(liveId);
    if (!reg) return;
    const list = [...reg.values()].map((v) => ({ name: v.name, joinedAt: v.joinedAt }));
    io.to(`live_${liveId}`).emit("live:viewerList", { viewers: list });
  };

  io.on("connection", (socket) => {
    console.log("🔌 Socket conectado:", socket.id);

    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.userId   = decoded.id;
        socket.data.username = decoded.name ?? decoded.username ?? null;
      }
    } catch {}

    socket.on("live:join", ({ liveId }) => {
      if (!liveId) return;
      socket.join(`live_${liveId}`);

      // Registrar viewer
      if (!viewerRegistry.has(liveId)) viewerRegistry.set(liveId, new Map());
      viewerRegistry.get(liveId).set(socket.id, {
        name:     socket.data.username ?? "Espectador",
        joinedAt: new Date().toISOString(),
      });

      const room  = io.sockets.adapter.rooms.get(`live_${liveId}`);
      const count = room ? room.size : 0;
      io.to(`live_${liveId}`).emit("live:viewerCount", { count });
      broadcastViewerList(liveId);

      // Enviar estado de compartir al nuevo viewer
      socket.emit("live:shareState", { enabled: shareEnabled.get(liveId) ?? true });
    });

    socket.on("live:registerStreamer", ({ liveId, username }) => {
      if (!liveId) return;
      streamers.set(liveId, socket.id);
      if (!shareEnabled.has(liveId)) shareEnabled.set(liveId, true);
      if (username) socket.data.username = username;
      socket.join(`live_${liveId}`);
      console.log(`🎥 Streamer registrado: liveId=${liveId}`);

      const pending = pendingViewers.get(liveId);
      if (pending?.size > 0) {
        for (const viewerSocketId of pending) {
          if (io.sockets.sockets.has(viewerSocketId)) {
            io.to(socket.id).emit("webrtc:newViewer", { viewerSocketId });
          }
        }
        pendingViewers.delete(liveId);
      }
    });

    // Owner activa/desactiva compartir
    socket.on("live:setShare", ({ liveId, enabled }) => {
      if (!liveId) return;
      if (streamers.get(liveId) !== socket.id) return; // solo el owner
      shareEnabled.set(liveId, !!enabled);
      io.to(`live_${liveId}`).emit("live:shareState", { enabled: !!enabled });
      console.log(`🔗 Compartir ${enabled ? "habilitado" : "deshabilitado"} en ${liveId}`);
    });

    socket.on("webrtc:viewerReady", ({ liveId }) => {
      if (!liveId) return;
      socket.join(`live_${liveId}`);
      const streamerSocketId = streamers.get(liveId);
      if (streamerSocketId && io.sockets.sockets.has(streamerSocketId)) {
        io.to(streamerSocketId).emit("webrtc:newViewer", { viewerSocketId: socket.id });
      } else {
        if (!pendingViewers.has(liveId)) pendingViewers.set(liveId, new Set());
        pendingViewers.get(liveId).add(socket.id);
      }
    });

    socket.on("live:chat", ({ liveId, message, username: clientUsername }) => {
      if (!liveId || !message?.trim()) return;
      const username = socket.data?.username ?? clientUsername ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:chat", {
        username,
        message: message.slice(0, 200),
        at: new Date().toISOString(),
      });
    });

    socket.on("live:gift", ({ liveId, type, amount }) => {
      if (!liveId) return;
      const from = socket.data?.username ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:gift", {
        from, type: type ?? "corazon",
        amount: Math.min(Number(amount) || 1, 999),
      });
    });

    socket.on("webrtc:offer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      if (!iceCandidateQueues.has(targetSocketId))
        iceCandidateQueues.set(targetSocketId, new Map());
      iceCandidateQueues.get(targetSocketId).set(socket.id, []);
      io.to(targetSocketId).emit("webrtc:offer", { streamerSocketId: socket.id, sdp });
    });

    socket.on("webrtc:answer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      io.to(targetSocketId).emit("webrtc:answer", { viewerSocketId: socket.id, sdp });
    });

    socket.on("webrtc:ice", ({ targetSocketId, candidate }) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit("webrtc:ice", { fromSocketId: socket.id, candidate });
    });

    socket.on("live:ownerEnd", ({ liveId }) => {
      if (!liveId) return;
      io.to(`live_${liveId}`).emit("live:ended", { liveId });
      streamers.delete(liveId);
      pendingViewers.delete(liveId);
      viewerRegistry.delete(liveId);
      shareEnabled.delete(liveId);
    });

    socket.on("live:leave", ({ liveId }) => {
      if (!liveId) return;
      pendingViewers.get(liveId)?.delete(socket.id);
      viewerRegistry.get(liveId)?.delete(socket.id);
      iceCandidateQueues.delete(socket.id);
      socket.leave(`live_${liveId}`);

      const room  = io.sockets.adapter.rooms.get(`live_${liveId}`);
      const count = room ? room.size : 0;
      io.to(`live_${liveId}`).emit("live:viewerCount", { count });
      broadcastViewerList(liveId);
    });

    socket.on("disconnect", () => {
      for (const [liveId, streamerSocketId] of streamers.entries()) {
        if (streamerSocketId === socket.id) {
          io.to(`live_${liveId}`).emit("live:ended", { liveId });
          streamers.delete(liveId);
          pendingViewers.delete(liveId);
          viewerRegistry.delete(liveId);
          shareEnabled.delete(liveId);
          break;
        }
      }
      for (const viewers of pendingViewers.values()) viewers.delete(socket.id);
      for (const [liveId, reg] of viewerRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          broadcastViewerList(liveId);
        }
      }
      iceCandidateQueues.delete(socket.id);
    });
  });
};