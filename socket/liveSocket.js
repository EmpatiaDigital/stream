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

  // liveId → Set<socketId>  (admins designados por el owner)
  const stageAdmins = new Map();

  // liveId → Map<socketId, { micLocked: bool, camLocked: bool }>
  // Registra si el owner/admin bloqueó los controles de un participante
  const stageLocks = new Map();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const isAuthorized = (liveId, socketId) =>
    streamers.get(liveId) === socketId ||
    stageAdmins.get(liveId)?.has(socketId);

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

  const broadcastStage = (liveId) => {
    const reg   = stageRegistry.get(liveId);
    const locks = stageLocks.get(liveId) ?? new Map();
    if (!reg) return;
    const participants = [...reg.entries()].map(([socketId, name]) => ({
      socketId,
      name,
      micLocked: locks.get(socketId)?.micLocked ?? false,
      camLocked: locks.get(socketId)?.camLocked ?? false,
    }));
    io.to(`live_${liveId}`).emit("live:stageUpdate", { participants });
  };

  // ── Broadcast lista de admins al owner ─────────────────────────────────────
  const broadcastAdmins = (liveId) => {
    const ownerSocketId = streamers.get(liveId);
    if (!ownerSocketId) return;
    const admins = [...(stageAdmins.get(liveId) ?? new Set())];
    io.to(ownerSocketId).emit("live:adminList", { admins });
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

    // ── JOIN ──────────────────────────────────────────────────────────────────
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

      if (stageRegistry.has(liveId)) {
        const locks = stageLocks.get(liveId) ?? new Map();
        const participants = [...stageRegistry.get(liveId).entries()].map(
          ([sid, name]) => ({
            socketId:  sid,
            name,
            micLocked: locks.get(sid)?.micLocked ?? false,
            camLocked: locks.get(sid)?.camLocked ?? false,
          })
        );
        socket.emit("live:stageUpdate", { participants });
      }

      // Si el socket que se une es un admin designado, informarle
      const liveAdmins = stageAdmins.get(liveId);
      if (liveAdmins?.has(socket.id)) {
        socket.emit("live:youAreAdmin", { liveId });
      }
    });

    // ── REGISTER STREAMER ─────────────────────────────────────────────────────
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

    // ── DESIGNAR / QUITAR ADMIN ───────────────────────────────────────────────
    socket.on("live:setAdmin", ({ liveId, targetSocketId, isAdmin }) => {
      if (!liveId || !targetSocketId) return;
      if (streamers.get(liveId) !== socket.id) return; // solo el owner

      if (!stageAdmins.has(liveId)) stageAdmins.set(liveId, new Set());
      const admins = stageAdmins.get(liveId);

      if (isAdmin) {
        admins.add(targetSocketId);
        // Notificar al nuevo admin
        io.to(targetSocketId).emit("live:youAreAdmin", { liveId });
        console.log(`👮 Admin designado: liveId=${liveId} socketId=${targetSocketId}`);
      } else {
        admins.delete(targetSocketId);
        io.to(targetSocketId).emit("live:adminRevoked", { liveId });
        console.log(`👮 Admin revocado: liveId=${liveId} socketId=${targetSocketId}`);
      }

      broadcastAdmins(liveId);
    });

    // ── SHARE STATE ───────────────────────────────────────────────────────────
    socket.on("live:setShare", ({ liveId, enabled }) => {
      if (!liveId) return;
      if (streamers.get(liveId) !== socket.id) return;
      shareEnabled.set(liveId, !!enabled);
      io.to(`live_${liveId}`).emit("live:shareState", { enabled: !!enabled });
    });

    // ── CAM STATE ─────────────────────────────────────────────────────────────
    socket.on("live:camState", ({ liveId, on }) => {
      if (!liveId) return;
      socket.to(`live_${liveId}`).emit("live:camState", { on: !!on });
    });

    // ── VIEWER READY ──────────────────────────────────────────────────────────
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

    // ── CHAT ──────────────────────────────────────────────────────────────────
    socket.on("live:chat", ({ liveId, message, username: clientUsername }) => {
      if (!liveId || !message?.trim()) return;
      const username = socket.data?.username ?? clientUsername ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:chat", {
        username,
        message: message.slice(0, 200),
        at: new Date().toISOString(),
      });
    });

    // ── GIFT ──────────────────────────────────────────────────────────────────
    socket.on("live:gift", ({ liveId, type, amount }) => {
      if (!liveId) return;
      const from = socket.data?.username ?? "Usuario";
      io.to(`live_${liveId}`).emit("live:gift", {
        from,
        type:   type ?? "corazon",
        amount: Math.min(Number(amount) || 1, 999),
      });
    });

    // ── WebRTC principal: offer / answer / ice ────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // ESCENARIO (stage)
    // ─────────────────────────────────────────────────────────────────────────

    socket.on("stage:invite", ({ liveId, targetSocketId }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;
      console.log(`🎙 stage:invite  owner/admin=${socket.id} → viewer=${targetSocketId}`);
      io.to(targetSocketId).emit("stage:invited", { ownerSocketId: socket.id, liveId });
    });

    socket.on("stage:offer", ({ targetSocketId, fromName, sdp }) => {
      if (!targetSocketId || !sdp) return;
      const name = fromName ?? socket.data?.username ?? "Invitado";
      io.to(targetSocketId).emit("stage:offer", {
        fromSocketId: socket.id,
        fromName:     name,
        sdp,
      });
    });

    socket.on("stage:answer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      for (const [liveId, streamerSocketId] of streamers.entries()) {
        if (streamerSocketId === socket.id) {
          if (!stageRegistry.has(liveId)) stageRegistry.set(liveId, new Map());
          if (!stageLocks.has(liveId))    stageLocks.set(liveId, new Map());
          const name = io.sockets.sockets.get(targetSocketId)?.data?.username ?? "Invitado";
          stageRegistry.get(liveId).set(targetSocketId, name);
          // Inicializar locks en false
          if (!stageLocks.get(liveId).has(targetSocketId)) {
            stageLocks.get(liveId).set(targetSocketId, { micLocked: false, camLocked: false });
          }
          broadcastStage(liveId);
          break;
        }
      }
      io.to(targetSocketId).emit("stage:answer", { sdp });
    });

    socket.on("stage:ice", ({ targetSocketId, candidate }) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit("stage:ice", { fromSocketId: socket.id, candidate });
    });

    socket.on("stage:remove", ({ liveId, targetSocketId }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;

      stageRegistry.get(liveId)?.delete(targetSocketId);
      stageLocks.get(liveId)?.delete(targetSocketId);
      broadcastStage(liveId);
      io.to(targetSocketId).emit("stage:removed");
    });

    // ── ADMIN MIC/CAM MUTE — con bloqueo de control ───────────────────────────
    /**
     * Emitido por owner/admin para silenciar mic de un participante.
     * Payload: { liveId, targetSocketId, mute: bool, lock: bool }
     *   - mute: true = apagar mic
     *   - lock: true = además bloquear el botón en el invitado
     *           false = solo silenciar, el invitado puede reactivar
     */
    socket.on("stage:adminMuteMic", ({ liveId, targetSocketId, mute, lock }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;

      // Actualizar lock en el servidor
      if (!stageLocks.has(liveId)) stageLocks.set(liveId, new Map());
      const locks = stageLocks.get(liveId);
      const cur   = locks.get(targetSocketId) ?? { micLocked: false, camLocked: false };
      locks.set(targetSocketId, { ...cur, micLocked: !!lock });

      // Notificar al invitado
      io.to(targetSocketId).emit("stage:adminMuteMic", { mute: !!mute, lock: !!lock });

      // Actualizar stageUpdate para todos (para reflejar locks)
      broadcastStage(liveId);

      console.log(`🎙 adminMuteMic → ${targetSocketId} mute=${mute} lock=${lock}`);
    });

    /**
     * Emitido por owner/admin para apagar cam de un participante.
     * Payload: { liveId, targetSocketId, off: bool, lock: bool }
     */
    socket.on("stage:adminMuteCam", ({ liveId, targetSocketId, off, lock }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;

      if (!stageLocks.has(liveId)) stageLocks.set(liveId, new Map());
      const locks = stageLocks.get(liveId);
      const cur   = locks.get(targetSocketId) ?? { micLocked: false, camLocked: false };
      locks.set(targetSocketId, { ...cur, camLocked: !!lock });

      io.to(targetSocketId).emit("stage:adminMuteCam", { off: !!off, lock: !!lock });

      broadcastStage(liveId);

      console.log(`🎙 adminMuteCam → ${targetSocketId} off=${off} lock=${lock}`);
    });

    // ── LIVE: OWNER END ───────────────────────────────────────────────────────
    socket.on("live:ownerEnd", ({ liveId }) => {
      if (!liveId) return;
      io.to(`live_${liveId}`).emit("live:ended", { liveId });
      streamers.delete(liveId);
      pendingViewers.delete(liveId);
      viewerRegistry.delete(liveId);
      shareEnabled.delete(liveId);
      stageRegistry.delete(liveId);
      stageLocks.delete(liveId);
      stageAdmins.delete(liveId);
    });

    // ── LIVE: LEAVE ───────────────────────────────────────────────────────────
    socket.on("live:leave", ({ liveId }) => {
      if (!liveId) return;
      pendingViewers.get(liveId)?.delete(socket.id);
      viewerRegistry.get(liveId)?.delete(socket.id);
      stageLocks.get(liveId)?.delete(socket.id);
      stageAdmins.get(liveId)?.delete(socket.id);
      iceCandidateQueues.delete(socket.id);
      socket.leave(`live_${liveId}`);

      if (stageRegistry.get(liveId)?.has(socket.id)) {
        stageRegistry.get(liveId).delete(socket.id);
        broadcastStage(liveId);
      }

      const room  = io.sockets.adapter.rooms.get(`live_${liveId}`);
      const count = room ? room.size : 0;
      io.to(`live_${liveId}`).emit("live:viewerCount", { count });
      broadcastViewerList(liveId);
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log("🔌 Socket desconectado:", socket.id);

      for (const [liveId, streamerSocketId] of streamers.entries()) {
        if (streamerSocketId === socket.id) {
          io.to(`live_${liveId}`).emit("live:ended", { liveId });
          streamers.delete(liveId);
          pendingViewers.delete(liveId);
          viewerRegistry.delete(liveId);
          shareEnabled.delete(liveId);
          stageRegistry.delete(liveId);
          stageLocks.delete(liveId);
          stageAdmins.delete(liveId);
          break;
        }
      }

      for (const viewers of pendingViewers.values()) {
        viewers.delete(socket.id);
      }

      for (const [liveId, reg] of viewerRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          broadcastViewerList(liveId);
        }
      }

      for (const [liveId, reg] of stageRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          stageLocks.get(liveId)?.delete(socket.id);
          broadcastStage(liveId);
        }
      }

      for (const admins of stageAdmins.values()) {
        admins.delete(socket.id);
      }

      iceCandidateQueues.delete(socket.id);
    });
  });
};
