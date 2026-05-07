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

  // liveId → Map<viewerSocketId, ownerSocketId>
  const stagePendingAnswers = new Map();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const isAuthorized = (liveId, socketId) =>
    streamers.get(liveId) === socketId ||
    stageAdmins.get(liveId)?.has(socketId);

  /**
   * Resuelve el nombre real del socket.
   *
   * PRIORIDAD (de mayor a menor):
   *   1. socket.data.username  ← decodificado del JWT en el handshake
   *   2. socket.data.name      ← alias del campo anterior
   *   3. "Usuario"             ← fallback (nunca debería llegar acá si el JWT está bien)
   *
   * NUNCA usamos el nombre que manda el cliente en el payload del evento;
   * eso era la causa del bug: si el cliente mandaba "" o "undefined" se
   * mostraba eso en lugar del nombre real.
   */
  const getSocketName = (socket) =>
    socket.data?.username?.trim() ||
    socket.data?.name?.trim()     ||
    "Usuario";

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
    // Decodificamos el JWT una sola vez al conectar y guardamos el nombre
    // en socket.data. A partir de acá SIEMPRE usamos getSocketName(socket).
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.data.userId = decoded.id ?? decoded._id ?? null;
        // Intentar todos los campos posibles donde puede venir el nombre
        const resolvedName =
          decoded.name?.trim()     ||
          decoded.username?.trim() ||
          decoded.email?.split("@")[0]?.trim() ||
          null;
        socket.data.username = resolvedName;
        socket.data.name     = resolvedName;
      }
    } catch {}

    // ── JOIN ──────────────────────────────────────────────────────────────
    // El cliente puede mandar `username` como respaldo, pero solo se usa
    // si el JWT no tenía nombre (caso muy improbable).
    socket.on("live:join", ({ liveId, username: clientUsername }) => {
      if (!liveId) return;
      socket.join(`live_${liveId}`);

      // Si el JWT no resolvió un nombre, usar el que mandó el cliente
      if (!socket.data.username && clientUsername?.trim()) {
        socket.data.username = clientUsername.trim();
        socket.data.name     = clientUsername.trim();
      }

      const name = getSocketName(socket);

      if (!viewerRegistry.has(liveId)) viewerRegistry.set(liveId, new Map());
      viewerRegistry.get(liveId).set(socket.id, {
        name,
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
        const participants = [...stageRegistry.get(liveId).entries()].map(([sid, sName]) => {
          const lock = locks.get(sid) ?? {};
          return {
            socketId:  sid,
            name:      sName,
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

      // Si ya hay participantes en el escenario, notificar al nuevo viewer
      // para que pueda iniciar conexión P2P con cada uno de ellos
      const stageReg = stageRegistry.get(liveId);
      const ownerSocketId = streamers.get(liveId);
      if (stageReg && stageReg.size > 0) {
        for (const [participantSocketId, participantName] of stageReg.entries()) {
          if (participantSocketId !== ownerSocketId) {
            socket.emit("stage:newParticipant", {
              participantSocketId,
              participantName,
            });
            // Decirle al participante del escenario que conecte con este nuevo viewer
            io.to(participantSocketId).emit("stage:connectToViewer", {
              viewerSocketId: socket.id,
            });
          }
        }
      }
    });

    // ── REGISTER STREAMER ──────────────────────────────────────────────────
    socket.on("live:registerStreamer", ({ liveId, username: clientUsername }) => {
      if (!liveId) return;
      streamers.set(liveId, socket.id);
      if (!shareEnabled.has(liveId)) shareEnabled.set(liveId, true);

      // Solo actualizar si el JWT no resolvió nombre
      if (!socket.data.username && clientUsername?.trim()) {
        socket.data.username = clientUsername.trim();
        socket.data.name     = clientUsername.trim();
      }

      socket.join(`live_${liveId}`);
      console.log(`🎥 Streamer registrado: liveId=${liveId} socketId=${socket.id} name=${getSocketName(socket)}`);

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
    // El username que manda el cliente se IGNORA completamente.
    // Siempre se usa el nombre del JWT (getSocketName).
    socket.on("live:chat", ({ liveId, message }) => {
      if (!liveId || !message?.trim()) return;
      const username = getSocketName(socket);
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

      if (!stagePendingAnswers.has(liveId)) stagePendingAnswers.set(liveId, new Map());
      stagePendingAnswers.get(liveId).set(targetSocketId, ownerSocketId ?? socket.id);

      io.to(targetSocketId).emit("stage:invited", {
        ownerSocketId: ownerSocketId ?? socket.id,
        liveId,
      });
    });

    // El VIEWER envía su offer al owner.
    // fromName se ignora; el nombre real viene del JWT del viewer.
    socket.on("stage:offer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      // Nombre resuelto desde el JWT del viewer (no del payload)
      const name = getSocketName(socket);
      console.log(`🎙 stage:offer viewer=${socket.id}(${name}) → owner/admin=${targetSocketId}`);
      io.to(targetSocketId).emit("stage:offer", {
        fromSocketId: socket.id,
        fromName:     name,
        sdp,
      });
    });

    // El OWNER/ADMIN envía su answer al viewer
    socket.on("stage:answer", ({ targetSocketId, sdp, liveId: answerLiveId }) => {
      if (!targetSocketId || !sdp) return;

      let foundLiveId = answerLiveId;

      if (!foundLiveId) {
        for (const [liveId, streamerSocketId] of streamers.entries()) {
          if (streamerSocketId === socket.id) { foundLiveId = liveId; break; }
        }
      }
      if (!foundLiveId) {
        for (const [liveId, admins] of stageAdmins.entries()) {
          if (admins.has(socket.id)) { foundLiveId = liveId; break; }
        }
      }

      if (foundLiveId) {
        if (!stageRegistry.has(foundLiveId)) stageRegistry.set(foundLiveId, new Map());
        if (!stageLocks.has(foundLiveId))    stageLocks.set(foundLiveId, new Map());

        // Nombre real del invitado: siempre desde socket.data del viewer
        const invitedSocket = io.sockets.sockets.get(targetSocketId);
        const name = invitedSocket
          ? getSocketName(invitedSocket)
          : (viewerRegistry.get(foundLiveId)?.get(targetSocketId)?.name ?? "Invitado");

        stageRegistry.get(foundLiveId).set(targetSocketId, name);
        if (!stageLocks.get(foundLiveId).has(targetSocketId)) {
          stageLocks.get(foundLiveId).set(targetSocketId, {
            micMuted: false, camOff: false,
            micLocked: false, camLocked: false,
          });
        }
        broadcastStage(foundLiveId);

        // Notificar a todos los viewers comunes (no owner, no el propio invitado)
        // para que puedan negociar WebRTC directamente con el nuevo participante
        // del escenario y así ver/escuchar sus tiles.
        const ownerSocketId = streamers.get(foundLiveId);
        const reg = viewerRegistry.get(foundLiveId);
        if (reg) {
          for (const [viewerSocketId] of reg.entries()) {
            if (
              viewerSocketId !== targetSocketId &&        // no el propio invitado
              viewerSocketId !== ownerSocketId  &&        // no el owner
              viewerSocketId !== socket.id               // no quien envió el answer
            ) {
              // Decirle al viewer que hay un nuevo participante en el escenario
              // y que debe iniciar negociación WebRTC con él
              io.to(viewerSocketId).emit("stage:newParticipant", {
                participantSocketId: targetSocketId,
                participantName:     name,
              });
              // Decirle al participante del escenario que hay un viewer esperando
              io.to(targetSocketId).emit("stage:connectToViewer", {
                viewerSocketId,
              });
            }
          }
        }
      }

      // fromSocketId = quien envía el answer (owner/admin), necesario para
      // que el viewer pueda hacer routing correcto en stagePCsRef.
      io.to(targetSocketId).emit("stage:answer", { sdp, fromSocketId: socket.id });
    });

    socket.on("stage:ice", ({ targetSocketId, candidate }) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit("stage:ice", { fromSocketId: socket.id, candidate });
    });

    // ── Señalización P2P entre participante del escenario y viewers normales ──
    // El participante del escenario envía offer a cada viewer normal
    socket.on("stage:viewerOffer", ({ targetSocketId, sdp, fromName }) => {
      if (!targetSocketId || !sdp) return;
      const name = getSocketName(socket) || fromName || "Invitado";
      io.to(targetSocketId).emit("stage:viewerOffer", {
        fromSocketId: socket.id,
        fromName:     name,
        sdp,
      });
    });

    // El viewer normal responde al participante del escenario
    socket.on("stage:viewerAnswer", ({ targetSocketId, sdp }) => {
      if (!targetSocketId || !sdp) return;
      io.to(targetSocketId).emit("stage:viewerAnswer", {
        fromSocketId: socket.id,
        sdp,
      });
    });

    // ICE candidates para conexiones viewer↔stage
    socket.on("stage:viewerIce", ({ targetSocketId, candidate }) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit("stage:viewerIce", {
        fromSocketId: socket.id,
        candidate,
      });
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

    // ── SPOTLIGHT ─────────────────────────────────────────────────────────
    // socketId puede ser null (quitar destaque) o un socketId válido
    socket.on("stage:spotlight", ({ liveId, socketId }) => {
      if (!liveId) return;
      if (!isAuthorized(liveId, socket.id)) return;
      // Broadcast a TODOS en el live (incluyendo el que emitió)
      io.to(`live_${liveId}`).emit("stage:spotlight", {
        socketId: socketId ?? null,
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
