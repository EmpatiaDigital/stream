// routes/uploadRoutes.js
import express from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import {
  createVideoPost,
  getMyPosts,
  updatePost,
  deleteVideoPost,
  getPostById,
} from "../controllers/uploadController.js";
import { authMiddleware } from "../controllers/profileController.js";

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── Storage dinámico según campo (video → mp4, resto → imagen) ───────────────
const dynamicStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isVideo = file.fieldname === "video";
    return {
      folder:         isVideo ? "talentos/videos" : "talentos/thumbnails",
      resource_type:  isVideo ? "video" : "image",
      transformation: isVideo
        ? [{ quality: "auto", fetch_format: "mp4" }]
        : [{ width: 1280, height: 720, crop: "fill", quality: "auto" }],
      public_id: isVideo
        ? `video_${req.user?.id ?? "u"}_${Date.now()}`
        : `img_${req.user?.id ?? "u"}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };
  },
});

const dynamicFilter = (_, file, cb) => {
  const images = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const videos = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/webm"];
  const ok = file.fieldname === "video"
    ? videos.includes(file.mimetype)
    : images.includes(file.mimetype);
  cb(null, ok);
};

// ─── Parser para crear: video + thumbnail + images (galería) ──────────────────
const uploadFields = multer({
  storage:    dynamicStorage,
  limits:     { fileSize: 200 * 1024 * 1024 },
  fileFilter: dynamicFilter,
}).fields([
  { name: "video",     maxCount: 1  },
  { name: "thumbnail", maxCount: 1  },
  { name: "images",    maxCount: 10 },   // galería para PhotoPost
]);

// ─── Parser para editar: solo thumbnail ───────────────────────────────────────
const uploadThumb = multer({
  storage:    dynamicStorage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: dynamicFilter,
}).single("thumbnail");

// ─── RUTAS ────────────────────────────────────────────────────────────────────
router.post("/",          authMiddleware, uploadFields, createVideoPost);
router.get("/my",         authMiddleware, getMyPosts);
router.get("/:postId",    getPostById);
router.put("/:postId",    authMiddleware, uploadThumb, updatePost);
router.delete("/:postId", authMiddleware, deleteVideoPost);

export default router;