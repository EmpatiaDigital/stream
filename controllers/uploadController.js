// controllers/uploadController.js
import "dotenv/config";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

// ─── Importar modelos discriminados ───
import Post      from "../models/postModel.js";
import VideoPost from "../models/videoPostModel.js";
import PhotoPost from "../models/photoPostModel.js";
import ShowPost  from "../models/showPostModel.js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── STORAGE PARA VIDEOS ───
const videoStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:         "talentos/videos",
    resource_type:  "video",
    transformation: [{ quality: "auto", fetch_format: "mp4" }],
    public_id:      `video_${req.user.id}_${Date.now()}`,
  }),
});

// ─── STORAGE PARA IMÁGENES (thumbnail + fotos de PhotoPost) ───
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder:         "talentos/thumbnails",
    resource_type:  "image",
    transformation: [{ width: 1280, height: 720, crop: "fill", quality: "auto" }],
    public_id:      `thumb_${req.user.id}_${Date.now()}`,
  }),
});

export const uploadVideoMulter = multer({
  storage:    videoStorage,
  limits:     { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"];
    cb(null, allowed.includes(file.mimetype));
  },
});

export const uploadImageMulter = multer({
  storage:    imageStorage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─────────────────────────────────────────────
// CREAR POST  (video | photo | show)
// ─────────────────────────────────────────────
export const createVideoPost = async (req, res) => {
  try {
    const { title, description, type = "video" } = req.body;

    // ── VIDEO ──
    if (type === "video") {
      if (!req.files?.video?.[0])
        return res.status(400).json({ error: "Se requiere un video" });

      const { category = "Talento Libre" } = req.body;
      const videoFile     = req.files.video[0];
      const thumbnailFile = req.files?.thumbnail?.[0];
      const videoUrl      = videoFile.path;
      const videoPublicId = videoFile.filename;

      const thumbnailUrl = thumbnailFile
        ? thumbnailFile.path
        : cloudinary.url(videoPublicId, {
            resource_type: "video",
            format:        "jpg",
            transformation: [
              { width: 1280, height: 720, crop: "fill" },
              { start_offset: "2" },
            ],
          });

      const post = await VideoPost.create({
        user:         req.user.id,
        title:        title || "Sin título",
        description:  description || "",
        url:          videoUrl,
        thumbnail:    thumbnailUrl,
        thumbnailId:  thumbnailFile?.filename,
        cloudinaryId: videoPublicId,
        category,
      });

      return res.status(201).json({ post });
    }

    // ── PHOTO ──
    if (type === "photo") {
      const { category = "Fotografía" } = req.body;
      const thumbnailFile = req.files?.thumbnail?.[0];

      if (!thumbnailFile)
        return res.status(400).json({ error: "Se requiere al menos una imagen" });

      // Imágenes extra (campo "images[]" en el form)
      const extraFiles = req.files?.images ?? [];
      const images = extraFiles.map((f) => ({
        url:      f.path,
        publicId: f.filename,
        caption:  "",
      }));

      const post = await PhotoPost.create({
        user:        req.user.id,
        title:       title || "Sin título",
        description: description || "",
        url:         thumbnailFile.path,     // url principal = primera imagen
        thumbnail:   thumbnailFile.path,
        thumbnailId: thumbnailFile.filename,
        category,
        images,
      });

      return res.status(201).json({ post });
    }

    // ── SHOW ──
    if (type === "show") {
      const {
        eventDate,
        venue, address, city, province,
        ticketPrice = 0,
        currency    = "ARS",
        isFree      = false,
        capacity,
        ticketUrl   = "",
      } = req.body;

      if (!eventDate)
        return res.status(400).json({ error: "Se requiere la fecha del evento" });
      if (!venue)
        return res.status(400).json({ error: "Se requiere el nombre del lugar" });

      const thumbnailFile = req.files?.thumbnail?.[0];

      const post = await ShowPost.create({
        user:        req.user.id,
        title:       title || "Sin título",
        description: description || "",
        thumbnail:   thumbnailFile?.path    ?? "/images/preview.png",
        thumbnailId: thumbnailFile?.filename,
        url:         "",
        eventDate:   new Date(eventDate),
        location:    { venue, address, city, province },
        ticketPrice: Number(ticketPrice),
        currency,
        isFree:      isFree === "true" || isFree === true,
        capacity:    capacity ? Number(capacity) : undefined,
        ticketUrl,
      });

      return res.status(201).json({ post });
    }

    return res.status(400).json({ error: `Tipo desconocido: ${type}` });
  } catch (err) {
    console.error("Error al crear post:", err);
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// LISTAR MIS POSTS
// ─────────────────────────────────────────────
export const getMyPosts = async (req, res) => {
  try {
    const { type, page = 1, limit = 12 } = req.query;
    const filter = { user: req.user.id };
    if (type) filter.type = type;

    const total = await Post.countDocuments(filter);
    const posts = await Post.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({ posts, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// ACTUALIZAR POST
// ─────────────────────────────────────────────
export const updatePost = async (req, res) => {
  try {
    const { title, description, category,
            eventDate, venue, address, city, province,
            ticketPrice, currency, isFree, capacity, ticketUrl } = req.body;

    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    if (post.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });

    // Campos base
    if (title)       post.title       = title;
    if (description !== undefined) post.description = description;

    // Campos por tipo
    if (post.type === "video" && category) post.category = category;

    if (post.type === "photo" && category) post.category = category;

    if (post.type === "show") {
      if (eventDate)    post.eventDate        = new Date(eventDate);
      if (venue)        post.location.venue   = venue;
      if (address)      post.location.address = address;
      if (city)         post.location.city    = city;
      if (province)     post.location.province = province;
      if (ticketPrice !== undefined) post.ticketPrice = Number(ticketPrice);
      if (currency)     post.currency         = currency;
      if (isFree !== undefined) post.isFree   = isFree === "true" || isFree === true;
      if (capacity)     post.capacity         = Number(capacity);
      if (ticketUrl !== undefined) post.ticketUrl = ticketUrl;
    }

    // Nueva thumbnail
    if (req.file) {
      if (post.thumbnailId) {
        await cloudinary.uploader.destroy(post.thumbnailId, { resource_type: "image" });
      }
      post.thumbnail   = req.file.path;
      post.thumbnailId = req.file.filename;
    }

    await post.save();
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// ELIMINAR POST
// ─────────────────────────────────────────────
export const deleteVideoPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    if (post.user.toString() !== req.user.id)
      return res.status(403).json({ error: "Sin permiso" });

    if (post.cloudinaryId) {
      await cloudinary.uploader.destroy(post.cloudinaryId, { resource_type: "video" });
    }
    if (post.thumbnailId) {
      await cloudinary.uploader.destroy(post.thumbnailId, { resource_type: "image" });
    }

    // Para PhotoPost: borrar imágenes extra de la galería
    if (post.type === "photo" && post.images?.length) {
      await Promise.all(
        post.images.map((img) =>
          img.publicId
            ? cloudinary.uploader.destroy(img.publicId, { resource_type: "image" })
            : Promise.resolve()
        )
      );
    }

    await post.deleteOne();
    res.json({ message: "Post eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─────────────────────────────────────────────
// OBTENER POST INDIVIDUAL
// ─────────────────────────────────────────────
export const getPostById = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId)
      .populate("user", "name username avatar");
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};