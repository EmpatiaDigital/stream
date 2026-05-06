import jwt from "jsonwebtoken";

export const setupLiveSocket = (io) => {
  const streamers          = new Map(); // liveId → socketId
  const pendingViewers     = new Map(); // liveId → Set<socketId>
  const iceCandidateQueues = new Map();

  // liveId → Map<socketId, { name, joinedAt, socketId }>
  const viewerRegistry = new Map();

  // liveId → boolean
  const shareEnabled = new Map();

  // liveId → Set<socketId>  (participantes actualmente en el escenario)
  const stageRegistry = new Map();

  // ── Helper: broadcast lista de viewers con socketId incluido ────────
  const broadcastViewerList = (liveId) => {
    const reg = viewerRegistry.get(liveId);
    if (!reg) return;
    const list = [...reg.entries()].map(([socketId, v]) => ({
      socketId,
      name:     v.name,
      joinedAt: v.joinedAt,
    }));
    io.to(`live_${liveId}`).emit("live:viewerList", { viewers: list });
  };

  // ── Helper: broadcast lista de participantes del escenario ───────────────
  const broadcastStage = (liveId) => {
    const reg = stageRegistry.get(liveId);
    if (!reg) return;
    const participants = [...reg.entries()].map(([socketId, name]) => ({ socketId, name }));
    io.to(`live_${liveId}`).emit("live:stageUpdate", { participants });
  };

  io.on("connection", (socket) => {
    console.log("🔌 Socket conectado:", socket.id);

    // ── Autenticación por JWT ─────────────────────────────────────────────
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.userId   = decoded.id;
        socket.data.username = decoded.name ?? decoded.username ?? null;
      }
    } catch {}

    // ── JOIN ─────────────────────────────────────────────────────────────
    socket.on("live:join", ({ liveId }) => {
      if (!liveId) return;
      socket.join(`live_${liveId}`);

      if (!viewerRegistry.has(liveId)) viewerRegistry.set(liveId, new Map());
      viewerRegistry.get(liveId).set(socket.id, {
        name:     socket.data.username ?? "Espectador",
        joinedAt: new Date().toISOString(),
        socketId: socket.id,
      });

      const room  = io.sockets.adapter.rooms.get(`live_${liveId}`);
      const count = room ? room.size : 0;
      io.to(`live_${liveId}`).emit("live:viewerCount", { count });
      broadcastViewerList(liveId);

      socket.emit("live:shareState", { enabled: shareEnabled.get(liveId) ?? true });

      // Si ya hay un escenario activo, enviarle el estado actual al recién llegado
      if (stageRegistry.has(liveId)) {
        const participants = [...stageRegistry.get(liveId).entries()].map(
          ([sid, name]) => ({ socketId: sid, name })
        );
        socket.emit("live:stageUpdate", { participants });
      }
    });

    // ── REGISTER STREAMER ─────────────────────────────────────────────────
    socket.on("live:registerStreamer", ({ liveId, username }) => {
      if (!liveId) return;
      streamers.set(liveId, socket.id);
      if (!shareEnabled.has(liveId)) shareEnabled.set(liveId, true);
      if (username) socket.data.username = username;
      socket.join(`live_${liveId}`);
      console.log(`🎥 Streamer registrado: liveId=${liveId} socketId=${socket.id}`);

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

    // ── SHARE STATE ───────────────────────────────────────────────────────
    socket.on("live:setShare", ({ liveId, enabled }) => {
      if (!liveId) return;
      if (streamers.get(liveId) !== socket.id) return;
      shareEnabled.set(liveId, !!enabled);
      io.to(`live_${liveId}`).emit("live:shareState", { enabled: !!enabled });
      console.log(`🔗 Compartir ${enabled ? "ON" : "OFF"} en ${liveId}`);
    });

    // ── CAM STATE ─────────────────────────────────────────────────────────
    socket.on("live:camState", ({ liveId, on }) => {
      if (!liveId) return;
      socket.to(`live_${liveId}`).emit("live:camState", { on: !!on });
    });

    // ── VIEWER READY (WebRTC principal streamer→viewer) ───────────────────
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

    // ── CHAT ──────────────────────────────────────────────────────────────
    socket.on("live:chat", ({ liveId, message, username: clientUsername }) => {
      if (!liveId || !message?.trim()) return;
      // El username siempre se toma del JWT (socket.data) para evitar spoofing
      const username = socket.data?.username ?? clientUsername ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:chat", {
        username,
        message: message.slice(0, 200),
        at: new Date().toISOString(),
      });
    });

    // ── GIFT ──────────────────────────────────────────────────────────────
    socket.on("live:gift", ({ liveId, type, amount }) => {
      if (!liveId) return;
      const from = socket.data?.username ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:gift", {
        from,
        type:   type ?? "corazon",
        amount: Math.min(Number(amount) || 1, 999),
      });
    });

    // ── WebRTC principal: offer / answer / ice ────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────
    // ESCENARIO (stage) — WebRTC bidireccional viewer → owner
    // Flujo:
    //   1. Owner emite  stage:invite  → servidor avisa al viewer con stage:invited
    //   2. Viewer abre su cámara y emite stage:offer (SDP) → servidor relay al owner
    //   3. Owner responde con stage:answer → servidor relay al viewer
    //   4. Ambos intercambian stage:ice  → relay punto a punto
    //   5. Owner puede emitir stage:remove → viewer recibe stage:removed
    // ─────────────────────────────────────────────────────────────────────

    // 1. Owner invita a un viewer al escenario
    socket.on("stage:invite", ({ liveId, targetSocketId }) => {
      if (!liveId || !targetSocketId) return;
      // Verificar que quien invita es el owner
      if (streamers.get(liveId) !== socket.id) return;

      console.log(`🎙 stage:invite  owner=${socket.id} → viewer=${targetSocketId}`);

      // Notificar al viewer que fue invitado, junto al socketId del owner
      io.to(targetSocketId).emit("stage:invited", { ownerSocketId: socket.id, liveId });
    });

    // 2. Viewer invitado envía su oferta SDP al owner
    socket.on("stage:offer", ({ targetSocketId, fromName, sdp }) => {
      if (!targetSocketId || !sdp) return;
      const name = fromName ?? socket.data?.username ?? "Invitado";
      console.log(`🎙 stage:offer  viewer=${socket.id}(${name}) → owner=${targetSocketId}`);
      io.to(targetSocketId).emit("stage:offer", {
        fromSocketId: socket.id,
        fromName:     name,
        sdp,
      });
    });

    // 3. Owner responde con SDP answer al viewer
    socket.on("stage:answer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      console.log(`🎙 stage:answer  owner=${socket.id} → viewer=${targetSocketId}`);
      // Registrar al viewer en el escenario del live correspondiente
      // Buscar el liveId cuyo owner es socket.id
      for (const [liveId, streamerSocketId] of streamers.entries()) {
        if (streamerSocketId === socket.id) {
          if (!stageRegistry.has(liveId)) stageRegistry.set(liveId, new Map());
          const name = io.sockets.sockets.get(targetSocketId)?.data?.username ?? "Invitado";
          stageRegistry.get(liveId).set(targetSocketId, name);
          broadcastStage(liveId);
          break;
        }
      }
      io.to(targetSocketId).emit("stage:answer", { sdp });
    });

    // 4. ICE candidates del escenario — relay punto a punto
    socket.on("stage:ice", ({ targetSocketId, candidate }) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit("stage:ice", {
        fromSocketId: socket.id,
        candidate,
      });
    });

    // 5. Owner quita a un participante del escenario
    socket.on("stage:remove", ({ liveId, targetSocketId }) => {
      if (!liveId || !targetSocketId) return;
      if (streamers.get(liveId) !== socket.id) return; // solo el owner

      console.log(`🎙 stage:remove  owner=${socket.id} quita a=${targetSocketId}`);

      // Actualizar registro
      stageRegistry.get(liveId)?.delete(targetSocketId);
      broadcastStage(liveId);

      // Notificar al viewer quitado
      io.to(targetSocketId).emit("stage:removed");
    });

    // ── LIVE: OWNER END ───────────────────────────────────────────────────
    socket.on("live:ownerEnd", ({ liveId }) => {
      if (!liveId) return;
      io.to(`live_${liveId}`).emit("live:ended", { liveId });
      streamers.delete(liveId);
      pendingViewers.delete(liveId);
      viewerRegistry.delete(liveId);
      shareEnabled.delete(liveId);
      stageRegistry.delete(liveId);
    });

    // ── LIVE: LEAVE ───────────────────────────────────────────────────────
    socket.on("live:leave", ({ liveId }) => {
      if (!liveId) return;
      pendingViewers.get(liveId)?.delete(socket.id);
      viewerRegistry.get(liveId)?.delete(socket.id);
      iceCandidateQueues.delete(socket.id);
      socket.leave(`live_${liveId}`);

      // Si estaba en el escenario, quitarlo
      if (stageRegistry.get(liveId)?.has(socket.id)) {
        stageRegistry.get(liveId).delete(socket.id);
        broadcastStage(liveId);
      }

      const room  = io.sockets.adapter.rooms.get(`live_${liveId}`);
      const count = room ? room.size : 0;
      io.to(`live_${liveId}`).emit("live:viewerCount", { count });
      broadcastViewerList(liveId);
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log("🔌 Socket desconectado:", socket.id);

      // Si era el streamer, terminar el live
      for (const [liveId, streamerSocketId] of streamers.entries()) {
        if (streamerSocketId === socket.id) {
          io.to(`live_${liveId}`).emit("live:ended", { liveId });
          streamers.delete(liveId);
          pendingViewers.delete(liveId);
          viewerRegistry.delete(liveId);
          shareEnabled.delete(liveId);
          stageRegistry.delete(liveId);
          break;
        }
      }

      // Limpiar de pendingViewers
      for (const viewers of pendingViewers.values()) {
        viewers.delete(socket.id);
      }

      // Limpiar de viewerRegistry y actualizar listas
      for (const [liveId, reg] of viewerRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          broadcastViewerList(liveId);
        }
      }

      // Si estaba en el escenario de algún live, quitarlo y notificar
      for (const [liveId, reg] of stageRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          broadcastStage(liveId);
        }
      }

      iceCandidateQueues.delete(socket.id);
    });
  });
};
