import jwt from "jsonwebtoken";

export const setupLiveSocket = (io) => {
  const streamers          = new Map(); // liveId → socketId
  const pendingViewers     = new Map(); // liveId → Set<socketId>
  const iceCandidateQueues = new Map();

  // liveId → Map<socketId, { name, joinedAt, socketId }>
  const viewerRegistry = new Map();

  // liveId → boolean
  const shareEnabled = new Map();

  // liveId → Map<socketId, name>
  const stageRegistry = new Map();

  // liveId → Set<socketId>
  const stageAdmins = new Map();

  // liveId → Map<socketId, { micLocked, camLocked, micMuted, camOff }>
  const stageLocks = new Map();

  // Mapa inverso: viewerSocketId → ownerSocketId (para stage answer routing)
  // liveId → Map<viewerSocketId, ownerSocketId>
  const stagePendingAnswers = new Map();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const isAuthorized = (liveId, socketId) =>
    streamers.get(liveId) === socketId ||
    stageAdmins.get(liveId)?.has(socketId);

  const getSocketName = (socket) => {
    // Prioridad: username del JWT > name del JWT > data guardada
    return socket.data?.username || socket.data?.name || "Usuario";
  };

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
    const participants = [...reg.entries()].map(([socketId, name]) => {
      const lock = locks.get(socketId) ?? {};
      return {
        socketId,
        name,
        micMuted:  lock.micMuted  ?? false,
        camOff:    lock.camOff    ?? false,
        micLocked: lock.micLocked ?? false,
        camLocked: lock.camLocked ?? false,
      };
    });
    io.to(`live_${liveId}`).emit("live:stageUpdate", { participants });
  };

  const broadcastAdmins = (liveId) => {
    const ownerSocketId = streamers.get(liveId);
    if (!ownerSocketId) return;
    const admins = [...(stageAdmins.get(liveId) ?? new Set())];
    io.to(ownerSocketId).emit("live:adminList", { admins });
  };

  io.on("connection", (socket) => {
    console.log("🔌 Socket conectado:", socket.id);

    // ── Auth JWT ───────────────────────────────────────────────────────────
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.userId   = decoded.id   ?? decoded._id ?? null;
        // Guardar TODOS los campos posibles de nombre
        socket.data.username = decoded.name ?? decoded.username ?? decoded.email?.split("@")[0] ?? null;
        socket.data.name     = socket.data.username;
      }
    } catch {}

    // ── JOIN ──────────────────────────────────────────────────────────────
    socket.on("live:join", ({ liveId }) => {
      if (!liveId) return;
      socket.join(`live_${liveId}`);

      if (!viewerRegistry.has(liveId)) viewerRegistry.set(liveId, new Map());
      viewerRegistry.get(liveId).set(socket.id, {
        name:     getSocketName(socket),
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
        const participants = [...stageRegistry.get(liveId).entries()].map(([sid, name]) => {
          const lock = locks.get(sid) ?? {};
          return {
            socketId:  sid,
            name,
            micMuted:  lock.micMuted  ?? false,
            camOff:    lock.camOff    ?? false,
            micLocked: lock.micLocked ?? false,
            camLocked: lock.camLocked ?? false,
          };
        });
        socket.emit("live:stageUpdate", { participants });
      }

      if (stageAdmins.get(liveId)?.has(socket.id)) {
        socket.emit("live:youAreAdmin", { liveId });
      }
    });

    // ── REGISTER STREAMER ──────────────────────────────────────────────────
    socket.on("live:registerStreamer", ({ liveId, username }) => {
      if (!liveId) return;
      streamers.set(liveId, socket.id);
      if (!shareEnabled.has(liveId)) shareEnabled.set(liveId, true);
      if (username) {
        socket.data.username = username;
        socket.data.name = username;
      }
      socket.join(`live_${liveId}`);
      console.log(`🎥 Streamer registrado: liveId=${liveId} socketId=${socket.id} name=${socket.data.username}`);

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

    // ── DESIGNAR / QUITAR ADMIN ────────────────────────────────────────────
    socket.on("live:setAdmin", ({ liveId, targetSocketId, isAdmin }) => {
      if (!liveId || !targetSocketId) return;
      if (streamers.get(liveId) !== socket.id) return;

      if (!stageAdmins.has(liveId)) stageAdmins.set(liveId, new Set());
      const admins = stageAdmins.get(liveId);

      if (isAdmin) {
        admins.add(targetSocketId);
        io.to(targetSocketId).emit("live:youAreAdmin", { liveId });
      } else {
        admins.delete(targetSocketId);
        io.to(targetSocketId).emit("live:adminRevoked", { liveId });
      }
      broadcastAdmins(liveId);
    });

    // ── SHARE STATE ────────────────────────────────────────────────────────
    socket.on("live:setShare", ({ liveId, enabled }) => {
      if (!liveId || streamers.get(liveId) !== socket.id) return;
      shareEnabled.set(liveId, !!enabled);
      io.to(`live_${liveId}`).emit("live:shareState", { enabled: !!enabled });
    });

    // ── CAM STATE ──────────────────────────────────────────────────────────
    socket.on("live:camState", ({ liveId, on }) => {
      if (!liveId) return;
      socket.to(`live_${liveId}`).emit("live:camState", { on: !!on });
    });

    // ── VIEWER READY ───────────────────────────────────────────────────────
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

    // ── CHAT ───────────────────────────────────────────────────────────────
    socket.on("live:chat", ({ liveId, message, username: clientUsername }) => {
      if (!liveId || !message?.trim()) return;
      // Usar SIEMPRE el nombre del JWT primero, luego el que manda el cliente
      const username = getSocketName(socket) || clientUsername || "Usuario";
      io.to(`live_${liveId}`).emit("live:chat", {
        username,
        message: message.slice(0, 200),
        at: new Date().toISOString(),
      });
    });

    // ── GIFT ───────────────────────────────────────────────────────────────
    socket.on("live:gift", ({ liveId, type, amount }) => {
      if (!liveId) return;
      io.to(`live_${liveId}`).emit("live:gift", {
        from:   getSocketName(socket),
        type:   type ?? "corazon",
        amount: Math.min(Number(amount) || 1, 999),
      });
    });

    // ── WebRTC principal ───────────────────────────────────────────────────
    socket.on("webrtc:offer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
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

    // ═════════════════════════════════════════════════════════════════════
    // ESCENARIO
    // ═════════════════════════════════════════════════════════════════════

    socket.on("stage:invite", ({ liveId, targetSocketId }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;
      const ownerSocketId = streamers.get(liveId);
      console.log(`🎙 stage:invite owner/admin=${socket.id} → viewer=${targetSocketId}`);

      // Guardar qué ownerSocketId espera el answer de este viewer
      if (!stagePendingAnswers.has(liveId)) stagePendingAnswers.set(liveId, new Map());
      stagePendingAnswers.get(liveId).set(targetSocketId, ownerSocketId ?? socket.id);

      io.to(targetSocketId).emit("stage:invited", {
        ownerSocketId: ownerSocketId ?? socket.id,
        liveId,
      });
    });

    // El VIEWER envía su offer al owner
    socket.on("stage:offer", ({ targetSocketId, fromName, sdp }) => {
      if (!targetSocketId || !sdp) return;
      const name = getSocketName(socket) || fromName || "Invitado";
      console.log(`🎙 stage:offer viewer=${socket.id}(${name}) → owner/admin=${targetSocketId}`);
      io.to(targetSocketId).emit("stage:offer", {
        fromSocketId: socket.id,
        fromName:     name,
        sdp,
      });
    });

    // El OWNER/ADMIN envía su answer al viewer
    // IMPORTANTE: el answer va de owner → viewer (targetSocketId = viewerSocketId)
    socket.on("stage:answer", ({ targetSocketId, sdp, liveId: answerLiveId }) => {
      if (!targetSocketId || !sdp) return;

      // Registrar al viewer en el escenario cuando el owner envía el answer
      // Buscar el liveId del que está enviando el answer (el owner/admin)
      let foundLiveId = answerLiveId;

      if (!foundLiveId) {
        // Buscar por streamers
        for (const [liveId, streamerSocketId] of streamers.entries()) {
          if (streamerSocketId === socket.id) {
            foundLiveId = liveId;
            break;
          }
        }
      }

      if (!foundLiveId) {
        // Buscar si es un admin
        for (const [liveId, admins] of stageAdmins.entries()) {
          if (admins.has(socket.id)) {
            foundLiveId = liveId;
            break;
          }
        }
      }

      if (foundLiveId) {
        if (!stageRegistry.has(foundLiveId)) stageRegistry.set(foundLiveId, new Map());
        if (!stageLocks.has(foundLiveId))    stageLocks.set(foundLiveId, new Map());

        // Nombre real del invitado (viewer que está en targetSocketId)
        const invitedSocket = io.sockets.sockets.get(targetSocketId);
        const name = invitedSocket
          ? (getSocketName(invitedSocket) || "Invitado")
          : (viewerRegistry.get(foundLiveId)?.get(targetSocketId)?.name ?? "Invitado");

        stageRegistry.get(foundLiveId).set(targetSocketId, name);
        if (!stageLocks.get(foundLiveId).has(targetSocketId)) {
          stageLocks.get(foundLiveId).set(targetSocketId, {
            micMuted: false, camOff: false,
            micLocked: false, camLocked: false,
          });
        }
        broadcastStage(foundLiveId);
      }

      // Enviar el answer al VIEWER (targetSocketId = viewerSocketId)
      io.to(targetSocketId).emit("stage:answer", { sdp, fromSocketId: socket.id });
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
      stagePendingAnswers.get(liveId)?.delete(targetSocketId);
      broadcastStage(liveId);
      io.to(targetSocketId).emit("stage:removed");
    });

    // ── DESTACAR participante en el escenario ──────────────────────────────
    socket.on("stage:spotlight", ({ liveId, targetSocketId }) => {
      if (!liveId) return;
      if (!isAuthorized(liveId, socket.id)) return;
      // Broadcast a todos en el live
      io.to(`live_${liveId}`).emit("stage:spotlight", {
        socketId: targetSocketId, // null = quitar spotlight
      });
    });

    // ── ADMIN MIC/CAM con lock ─────────────────────────────────────────────
    socket.on("stage:adminMuteMic", ({ liveId, targetSocketId, mute, lock }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;

      if (!stageLocks.has(liveId)) stageLocks.set(liveId, new Map());
      const locks = stageLocks.get(liveId);
      const cur   = locks.get(targetSocketId) ?? {};
      locks.set(targetSocketId, { ...cur, micMuted: !!mute, micLocked: !!lock });

      io.to(targetSocketId).emit("stage:adminMuteMic", { mute: !!mute, lock: !!lock });
      broadcastStage(liveId);
    });

    socket.on("stage:adminMuteCam", ({ liveId, targetSocketId, off, lock }) => {
      if (!liveId || !targetSocketId) return;
      if (!isAuthorized(liveId, socket.id)) return;

      if (!stageLocks.has(liveId)) stageLocks.set(liveId, new Map());
      const locks = stageLocks.get(liveId);
      const cur   = locks.get(targetSocketId) ?? {};
      locks.set(targetSocketId, { ...cur, camOff: !!off, camLocked: !!lock });

      io.to(targetSocketId).emit("stage:adminMuteCam", { off: !!off, lock: !!lock });
      broadcastStage(liveId);
    });

    socket.on("stage:selfState", ({ liveId, micOn, camOn }) => {
      if (!liveId) return;
      if (!stageLocks.has(liveId)) return;
      const locks = stageLocks.get(liveId);
      const cur   = locks.get(socket.id) ?? {};
      // Solo actualizar muted/off si no está bloqueado
      const updated = { ...cur };
      if (!cur.micLocked) updated.micMuted = !micOn;
      if (!cur.camLocked) updated.camOff   = !camOn;
      locks.set(socket.id, updated);
      broadcastStage(liveId);
    });

    // ── LIVE: OWNER END ────────────────────────────────────────────────────
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
      stagePendingAnswers.delete(liveId);
    });

    // ── LIVE: LEAVE ────────────────────────────────────────────────────────
    socket.on("live:leave", ({ liveId }) => {
      if (!liveId) return;
      pendingViewers.get(liveId)?.delete(socket.id);
      viewerRegistry.get(liveId)?.delete(socket.id);
      stageLocks.get(liveId)?.delete(socket.id);
      stageAdmins.get(liveId)?.delete(socket.id);
      stagePendingAnswers.get(liveId)?.delete(socket.id);
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

    // ── DISCONNECT ─────────────────────────────────────────────────────────
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
          stagePendingAnswers.delete(liveId);
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

      for (const [liveId, reg] of stageRegistry.entries()) {
        if (reg.has(socket.id)) {
          reg.delete(socket.id);
          stageLocks.get(liveId)?.delete(socket.id);
          stagePendingAnswers.get(liveId)?.delete(socket.id);
          broadcastStage(liveId);
        }
      }

      for (const admins of stageAdmins.values()) admins.delete(socket.id);

      iceCandidateQueues.delete(socket.id);
    });
  });
};
