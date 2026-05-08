/**
 * liveSocket.js — servidor de Socket.IO para lives
 *
 * FIXES:
 * 1. stage:spotlight ahora se re-emite a TODOS los viewers del live
 * 2. live:join/leave notifica al owner con nombre + total de participantes
 * 3. stage:viewerOffer ahora incluye flag para que el viewer NO mutee el audio
 */

const liveRooms   = new Map(); // liveId → { streamerId, viewers: Map<socketId, {name}>, admins: Set, shareEnabled, spotlightId }
const stageRooms  = new Map(); // liveId → Set<socketId> de participantes en escenario

function getRoom(liveId) {
  if (!liveRooms.has(liveId)) {
    liveRooms.set(liveId, {
      streamerId:    null,
      viewers:       new Map(),   // socketId → { name, isAdmin }
      admins:        new Set(),
      shareEnabled:  true,
      spotlightId:   null,
    });
  }
  return liveRooms.get(liveId);
}

function getStage(liveId) {
  if (!stageRooms.has(liveId)) stageRooms.set(liveId, new Map()); // socketId → StageParticipant
  return stageRooms.get(liveId);
}

function broadcastViewerList(io, liveId) {
  const room = getRoom(liveId);
  const viewers = Array.from(room.viewers.entries()).map(([socketId, info]) => ({
    socketId,
    name:    info.name,
    isAdmin: room.admins.has(socketId),
  }));
  io.to(`live_${liveId}`).emit("live:viewerList",  { viewers });
  io.to(`live_${liveId}`).emit("live:viewerCount", { count: viewers.length });
}

function broadcastStageUpdate(io, liveId) {
  const stage = getStage(liveId);
  const participants = Array.from(stage.values());
  io.to(`live_${liveId}`).emit("live:stageUpdate", { participants });
}

export function setupLiveSocket(io) {

  // ── Autenticación básica del socket ──────────────────────────────────────
  io.use((socket, next) => {
    // Podés validar el JWT aquí si querés mayor seguridad
    next();
  });

  io.on("connection", (socket) => {

    // ── JOIN ────────────────────────────────────────────────────────────────
    socket.on("live:join", ({ liveId, username }) => {
      if (!liveId) return;
      const room = getRoom(liveId);
      socket.join(`live_${liveId}`);

      const name = username?.trim() || "Anónimo";
      const isNew = !room.viewers.has(socket.id);
      room.viewers.set(socket.id, { name });

      broadcastViewerList(io, liveId);

      // Notificar al streamer (owner) sobre el join — solo si no es el propio streamer
      if (room.streamerId && room.streamerId !== socket.id) {
        io.to(room.streamerId).emit("live:userJoined", {
          socketId: socket.id,
          name,
          total: room.viewers.size,
        });
      }

      // Si hay spotlight activo, enviárselo al recién llegado
      if (room.spotlightId) {
        socket.emit("stage:spotlight", { socketId: room.spotlightId });
      }

      // Si hay participantes en escenario, avisar al viewer para que
      // inicie conexiones con cada uno
      const stage = getStage(liveId);
      if (stage.size > 0) {
        stage.forEach((participant, participantSocketId) => {
          // Le decimos al participante que conecte con este nuevo viewer
          io.to(participantSocketId).emit("stage:connectToViewer", {
            viewerSocketId: socket.id,
          });
        });
      }

      // Sincronizar shareEnabled
      socket.emit("live:shareState", { enabled: room.shareEnabled });
    });

    // ── REGISTER STREAMER ───────────────────────────────────────────────────
    socket.on("live:registerStreamer", ({ liveId, username }) => {
      if (!liveId) return;
      const room = getRoom(liveId);
      room.streamerId = socket.id;
      socket.join(`live_${liveId}`);
      const name = username?.trim() || "Streamer";
      room.viewers.set(socket.id, { name, isStreamer: true });
      broadcastViewerList(io, liveId);

      // Enviar lista de admins actual al streamer
      socket.emit("live:adminList", { admins: Array.from(room.admins) });
    });

    // ── LEAVE (explícito) ───────────────────────────────────────────────────
    socket.on("live:leave", ({ liveId }) => {
      if (!liveId) return;
      handleLeave(socket, liveId, io);
    });

    // ── DISCONNECT ──────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      // Buscar en qué lives estaba este socket
      for (const [liveId, room] of liveRooms.entries()) {
        if (room.viewers.has(socket.id) || room.streamerId === socket.id) {
          handleLeave(socket, liveId, io);
        }
      }
    });

    // ── CHAT ────────────────────────────────────────────────────────────────
    socket.on("live:chat", ({ liveId, message, username }) => {
      if (!liveId || !message?.trim()) return;
      const room = getRoom(liveId);
      // El nombre siempre viene del servidor (lo que se registró en join)
      const name = room.viewers.get(socket.id)?.name || username?.trim() || "Anónimo";
      io.to(`live_${liveId}`).emit("live:chat", {
        username: name,
        message:  message.trim().slice(0, 200),
        ts:       Date.now(),
      });
    });

    // ── SHARE STATE ─────────────────────────────────────────────────────────
    socket.on("live:setShare", ({ liveId, enabled }) => {
      const room = getRoom(liveId);
      if (room.streamerId !== socket.id) return;
      room.shareEnabled = !!enabled;
      io.to(`live_${liveId}`).emit("live:shareState", { enabled: room.shareEnabled });
    });

    // ── CAM STATE ───────────────────────────────────────────────────────────
    socket.on("live:camState", ({ liveId, on }) => {
      socket.to(`live_${liveId}`).emit("live:camState", { on: !!on });
    });

    // ── END LIVE (owner) ────────────────────────────────────────────────────
    socket.on("live:ownerEnd", ({ liveId }) => {
      const room = getRoom(liveId);
      if (room.streamerId !== socket.id) return;
      io.to(`live_${liveId}`).emit("live:ended", { liveId });
      liveRooms.delete(liveId);
      stageRooms.delete(liveId);
    });

    // ── ADMIN ───────────────────────────────────────────────────────────────
    socket.on("live:setAdmin", ({ liveId, targetSocketId, isAdmin }) => {
      const room = getRoom(liveId);
      if (room.streamerId !== socket.id) return;

      if (isAdmin) {
        room.admins.add(targetSocketId);
        io.to(targetSocketId).emit("live:youAreAdmin");
      } else {
        room.admins.delete(targetSocketId);
        io.to(targetSocketId).emit("live:adminRevoked");
      }

      io.to(`live_${liveId}`).emit("live:adminList", { admins: Array.from(room.admins) });
      broadcastViewerList(io, liveId);
    });

    // ── WebRTC principal ────────────────────────────────────────────────────
    socket.on("webrtc:viewerReady", ({ liveId }) => {
      const room = getRoom(liveId);
      if (room.streamerId) {
        io.to(room.streamerId).emit("webrtc:newViewer", { viewerSocketId: socket.id });
      }
    });

    socket.on("webrtc:offer", ({ targetSocketId, sdp }) => {
      io.to(targetSocketId).emit("webrtc:offer", { streamerSocketId: socket.id, sdp });
    });

    socket.on("webrtc:answer", ({ targetSocketId, sdp }) => {
      io.to(targetSocketId).emit("webrtc:answer", { viewerSocketId: socket.id, sdp });
    });

    socket.on("webrtc:ice", ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit("webrtc:ice", { fromSocketId: socket.id, candidate });
    });

    // ── ESCENARIO ───────────────────────────────────────────────────────────
    socket.on("stage:invite", ({ liveId, targetSocketId }) => {
      const room = getRoom(liveId);
      const isAuthority = room.streamerId === socket.id || room.admins.has(socket.id);
      if (!isAuthority) return;
      io.to(targetSocketId).emit("stage:invited", { ownerSocketId: socket.id });
    });

    socket.on("stage:offer", ({ targetSocketId, fromName, sdp }) => {
      io.to(targetSocketId).emit("stage:offer", {
        fromSocketId: socket.id,
        fromName,
        sdp,
      });
    });

    socket.on("stage:answer", ({ targetSocketId, sdp }) => {
      io.to(targetSocketId).emit("stage:answer", {
        fromSocketId: socket.id,
        sdp,
      });
    });

    socket.on("stage:ice", ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit("stage:ice", { fromSocketId: socket.id, candidate });
    });

    socket.on("stage:remove", ({ liveId, targetSocketId }) => {
      const room  = getRoom(liveId);
      const stage = getStage(liveId);
      const isAuthority = room.streamerId === socket.id || room.admins.has(socket.id);
      if (!isAuthority) return;

      stage.delete(targetSocketId);
      io.to(targetSocketId).emit("stage:removed");
      broadcastStageUpdate(io, liveId);
    });

    socket.on("stage:selfState", ({ liveId, micOn, camOn }) => {
      const stage = getStage(liveId);
      if (stage.has(socket.id)) {
        const p = stage.get(socket.id);
        stage.set(socket.id, { ...p, micMuted: !micOn, camOff: !camOn });
        broadcastStageUpdate(io, liveId);
      }
    });

    // El viewer confirma que subió al escenario → registrar en stage
    socket.on("stage:joined", ({ liveId, name, micOn, camOn }) => {
      const stage = getStage(liveId);
      const room  = getRoom(liveId);
      const resolvedName = room.viewers.get(socket.id)?.name || name || "Invitado";
      stage.set(socket.id, {
        socketId:  socket.id,
        name:      resolvedName,
        micMuted:  !micOn,
        camOff:    !camOn,
        micLocked: false,
        camLocked: false,
      });
      broadcastStageUpdate(io, liveId);

      // Decirle a cada viewer existente que conecte con este nuevo participante
      room.viewers.forEach((_, viewerSocketId) => {
        if (viewerSocketId !== socket.id && viewerSocketId !== room.streamerId) {
          io.to(socket.id).emit("stage:connectToViewer", { viewerSocketId });
        }
      });
    });

    socket.on("stage:adminMuteMic", ({ liveId, targetSocketId, mute, lock }) => {
      const room = getRoom(liveId);
      const isAuthority = room.streamerId === socket.id || room.admins.has(socket.id);
      if (!isAuthority) return;

      const stage = getStage(liveId);
      if (stage.has(targetSocketId)) {
        const p = stage.get(targetSocketId);
        stage.set(targetSocketId, { ...p, micMuted: mute, micLocked: lock });
        broadcastStageUpdate(io, liveId);
      }
      io.to(targetSocketId).emit("stage:adminMuteMic", { mute, lock });
    });

    socket.on("stage:adminMuteCam", ({ liveId, targetSocketId, off, lock }) => {
      const room = getRoom(liveId);
      const isAuthority = room.streamerId === socket.id || room.admins.has(socket.id);
      if (!isAuthority) return;

      const stage = getStage(liveId);
      if (stage.has(targetSocketId)) {
        const p = stage.get(targetSocketId);
        stage.set(targetSocketId, { ...p, camOff: off, camLocked: lock });
        broadcastStageUpdate(io, liveId);
      }
      io.to(targetSocketId).emit("stage:adminMuteCam", { off, lock });
    });

    // ── SPOTLIGHT — FIX: ahora se emite a TODOS ─────────────────────────────
    socket.on("stage:spotlight", ({ liveId, socketId }) => {
      const room = getRoom(liveId);
      const isAuthority = room.streamerId === socket.id || room.admins.has(socket.id);
      if (!isAuthority) return;

      // Guardar en el estado del servidor para los que se unan después
      room.spotlightId = socketId;

      // Re-emitir a TODOS los viewers (incluido el owner)
      io.to(`live_${liveId}`).emit("stage:spotlight", { socketId });
    });

    // ── Viewer↔Stage WebRTC ─────────────────────────────────────────────────
    socket.on("stage:connectToViewer", ({ liveId, viewerSocketId }) => {
      // El participante del escenario inicia el offer hacia el viewer
      io.to(socket.id).emit("stage:connectToViewer", { viewerSocketId });
    });

    socket.on("stage:viewerOffer", ({ targetSocketId, fromName, sdp }) => {
      io.to(targetSocketId).emit("stage:viewerOffer", {
        fromSocketId: socket.id,
        fromName,
        sdp,
        // FIX: indicar al viewer que NO mutee el audio de este stream
        audioEnabled: true,
      });
    });

    socket.on("stage:viewerAnswer", ({ targetSocketId, sdp }) => {
      io.to(targetSocketId).emit("stage:viewerAnswer", {
        fromSocketId: socket.id,
        sdp,
      });
    });

    socket.on("stage:viewerIce", ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit("stage:viewerIce", {
        fromSocketId: socket.id,
        candidate,
      });
    });
  });
}

// ── Helper: limpiar cuando un socket se va ──────────────────────────────────
function handleLeave(socket, liveId, io) {
  const room  = getRoom(liveId);
  const stage = getStage(liveId);

  const viewerInfo = room.viewers.get(socket.id);
  const name = viewerInfo?.name || "Alguien";

  room.viewers.delete(socket.id);
  room.admins.delete(socket.id);
  socket.leave(`live_${liveId}`);

  // Si estaba en el escenario, removerlo
  if (stage.has(socket.id)) {
    stage.delete(socket.id);
    broadcastStageUpdate(io, liveId);

    // Si era el participante destacado, limpiar spotlight
    if (room.spotlightId === socket.id) {
      room.spotlightId = null;
      io.to(`live_${liveId}`).emit("stage:spotlight", { socketId: null });
    }
  }

  broadcastViewerList(io, liveId);

  // Notificar al streamer sobre el leave
  if (room.streamerId && room.streamerId !== socket.id) {
    io.to(room.streamerId).emit("live:userLeft", {
      socketId: socket.id,
      name,
      total: room.viewers.size,
    });
  }

  // Si era el streamer, limpiar la sala
  if (room.streamerId === socket.id) {
    room.streamerId = null;
  }

  // Limpiar sala si está vacía
  if (room.viewers.size === 0) {
    liveRooms.delete(liveId);
    stageRooms.delete(liveId);
  }
}
