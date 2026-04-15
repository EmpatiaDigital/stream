import { v2 as cloudinary } from "cloudinary";
import { v4 as uuid } from "uuid";
import LivePost from "../models/livePostModel.js";
import User from "../models/userModel.js";

const MEDIA_SERVER = process.env.MEDIA_SERVER_URL || "http://localhost:8888";
const RTMP_SERVER  = process.env.RTMP_SERVER_URL  || "rtmp://localhost:1935";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── CREAR LIVE ──────────────────────────────────────────────────────────────
export const createLive = async (req, res) => {
  try {
    const { title, description, category, scheduled } = req.body;
    if (!title) return res.status(400).json({ error: "El título es requerido" });

    const streamKey = `${req.user.id}_${uuid().slice(0, 8)}`;
    const thumbnail = req.file?.path || "/images/preview.png";

    const live = await LivePost.create({
      user:        req.user.id,
      title,
      description: description || "",
      category:    category    || "general",
      scheduled:   scheduled   || null,
      thumbnail,
      streamKey,
      rtmpUrl:   `${RTMP_SERVER}/live/${streamKey}`,
      hlsUrl:    `${MEDIA_SERVER}/live/${streamKey}/index.m3u8`,
      webrtcUrl: `${MEDIA_SERVER}/live/${streamKey}`,
      status:    "live",
      startedAt: new Date(),
    });

    const io   = req.app.locals.io;
    const user = await User.findById(req.user.id).select("name avatar subscribers");
    if (io && user?.subscribers?.length) {
      user.subscribers.forEach((subId) => {
        io.to(`user_${subId}`).emit("live:newLive", {
          liveId:    live._id,
          title:     live.title,
          streamer:  user.name,
          avatar:    user.avatar,
          thumbnail: live.thumbnail,
        });
      });
    }

    res.status(201).json({
      live,
      streamInstructions: {
        server:    `${RTMP_SERVER}/live`,
        streamKey,
        fullRtmp:  `${RTMP_SERVER}/live/${streamKey}`,
        hlsUrl:    live.hlsUrl,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── LISTAR LIVES ACTIVOS (alias requerido por liveRoutes) ───────────────────
// El router usa "listLives" así que exportamos con ese nombre
export const listLives = async (req, res) => {
  try {
    const lives = await LivePost.find({ status: "live" })
      .populate("user", "name avatar")
      .sort({ viewerCount: -1 })
      .limit(20);
    res.json({ lives });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};



// ─── LIVES ACTIVOS (ruta pública para la navbar) ─────────────────────────────
export const getActiveLives = async (req, res) => {
  try {
    const lives = await LivePost.find({ status: "live" })
      .populate("user", "name avatar")
      .sort({ viewerCount: -1 })
      .limit(20)
      .lean();
    // Devuelve array directo para que el fetch de la navbar lo reciba como Array.isArray()
    res.json(lives);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── OBTENER LIVE POR ID ─────────────────────────────────────────────────────
export const getLive = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId)
      .populate("user", "name avatar username subscribers");
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    res.json({ live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── MIS LIVES ───────────────────────────────────────────────────────────────
export const getMyLives = async (req, res) => {
  try {
    const lives = await LivePost.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json({ lives });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── ACTUALIZAR LIVE ─────────────────────────────────────────────────────────
export const updateLive = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });

    const { title, description, category } = req.body;
    if (title)       live.title       = title;
    if (description) live.description = description;
    if (category)    live.category    = category;
    await live.save();

    res.json({ live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── FINALIZAR LIVE ──────────────────────────────────────────────────────────
export const endLive = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });

    live.status  = "ended";
    live.endedAt = new Date();
    await live.save();

    // Notificar por socket a todos los viewers
    const io = req.app.locals.io;
    if (io) {
      io.to(`live_${req.params.liveId}`).emit("live:ended", { liveId: req.params.liveId });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── STREAM KEY ──────────────────────────────────────────────────────────────
export const getStreamKey = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });
    res.json({ streamKey: live.streamKey, rtmpUrl: live.rtmpUrl, hlsUrl: live.hlsUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── ENVIAR REGALO ───────────────────────────────────────────────────────────
export const sendGift = async (req, res) => {
  try {
    const { type = "corazon", amount = 1, message } = req.body;
    const qty = Math.min(Math.max(1, Number(amount)), 99);

    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.status !== "live")
      return res.status(400).json({ error: "El live no está activo" });

    // Verificar y descontar saldo
    const user = await User.findById(req.user.id).select("name avatar giftBalance");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const current = user.giftBalance?.[type] ?? 0;
    if (current < qty)
      return res.status(400).json({ 
        error: `Saldo insuficiente. Tenés ${current} ${type}(s)` 
      });

    // Descontar del balance
    user.giftBalance[user.giftBalance instanceof Map ? "set" : type] = current - qty;
    // Para objeto plano en Mongoose, marcarlo como modificado:
    user.markModified("giftBalance");
    await user.save();

    const gift = {
      from: req.user.id, fromName: user.name, type,
      amount: qty, message: message?.slice(0, 100), at: new Date(),
    };

    live.gifts.push(gift);
    live.totalGifts = (live.totalGifts || 0) + qty;
    await live.save();

    const io = req.app.locals.io;
    if (io) {
      io.to(`live_${req.params.liveId}`).emit("live:gift", {
        from:    user.name,
        avatar:  user.avatar,
        type:    gift.type,
        amount:  gift.amount,
        message: gift.message,
        liveId:  req.params.liveId,
      });
    }

    res.json({ 
      gift, 
      totalGifts:   live.totalGifts,
      // Devolver nuevo saldo para actualizar el frontend
      newBalance:   current - qty,
      balanceType:  type,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── SUBIR THUMBNAIL ─────────────────────────────────────────────────────────
export const uploadThumbnail = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });
    if (!req.file) return res.status(400).json({ error: "Archivo requerido" });
    live.thumbnail = req.file.path;
    await live.save();
    res.json({ live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── WEBHOOKS RTMP ───────────────────────────────────────────────────────────
export const webhookStreamStart = async (req, res) => {
  try {
    const { streamKey } = req.body;
    if (!streamKey) return res.status(400).json({ error: "streamKey requerido" });
    const live = await LivePost.findOneAndUpdate(
      { streamKey }, { status: "live", startedAt: new Date() }, { new: true }
    ).populate("user", "name subscribers");
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    const io = req.app.locals.io;
    if (io && live.user?.subscribers?.length) {
      live.user.subscribers.forEach((subId) => {
        io.to(`user_${subId}`).emit("live:started", {
          liveId: live._id, title: live.title, streamer: live.user.name,
        });
      });
    }
    console.log(`🔴 Stream iniciado: ${streamKey}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const webhookStreamEnd = async (req, res) => {
  try {
    const { streamKey } = req.body;
    if (!streamKey) return res.status(400).json({ error: "streamKey requerido" });
    const live = await LivePost.findOneAndUpdate(
      { streamKey }, { status: "ended", endedAt: new Date() }, { new: true }
    );
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    const io = req.app.locals.io;
    if (io) io.to(`live_${live._id}`).emit("live:ended", { liveId: live._id });
    console.log(`⚫ Stream terminado: ${streamKey}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── SUBIR VOD ───────────────────────────────────────────────────────────────
export const uploadVod = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });
    if (!req.file) return res.status(400).json({ error: "Archivo requerido" });
    live.vodUrl = req.file.path;
    live.status = "ended";
    await live.save();
    res.json({ live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── ELIMINAR LIVE ───────────────────────────────────────────────────────────
export const deleteLive = async (req, res) => {
  try {
    const live = await LivePost.findById(req.params.liveId);
    if (!live) return res.status(404).json({ error: "Live no encontrado" });
    if (live.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });
    if (live.thumbnailId)
      await cloudinary.uploader.destroy(live.thumbnailId, { resource_type: "image" }).catch(() => {});
    if (live.vodPublicId)
      await cloudinary.uploader.destroy(live.vodPublicId, { resource_type: "video" }).catch(() => {});
    await live.deleteOne();
    res.json({ message: "Live eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getGiftBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("giftBalance");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json({ balance: user.giftBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Simulación de compra (en producción conectarías un payment gateway)
export const buyGifts = async (req, res) => {
  try {
    const { type, quantity } = req.body;
    const validTypes = ["corazon","estrella","fuego","diamante","corona","cohete"];
    if (!validTypes.includes(type)) 
      return res.status(400).json({ error: "Tipo inválido" });

    const qty = Math.min(Math.max(1, Number(quantity)), 999);
    const user = await User.findById(req.user.id);
    
    user.giftBalance[type] = (user.giftBalance[type] ?? 0) + qty;
    user.markModified("giftBalance");
    await user.save();

    res.json({ balance: user.giftBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
