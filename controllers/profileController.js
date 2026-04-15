// controllers/profileController.js
import User from "../models/userModel.js";
import Post from "../models/postModel.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

// ─── CLOUDINARY CONFIG ───
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── CLOUDINARY STORAGE PARA AVATAR Y BANNER ───
const profileStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isAvatar = file.fieldname === "avatar";
    return {
      folder:         isAvatar ? "talentos/avatars" : "talentos/banners",
      resource_type:  "image",
      transformation: isAvatar
        ? [{ width: 400,  height: 400,  crop: "fill", quality: "auto" }]
        : [{ width: 1200, height: 400,  crop: "fill", quality: "auto" }],
      public_id: `${file.fieldname}_${req.user.id}_${Date.now()}`,
    };
  },
});

export const upload = multer({
  storage:    profileStorage,
  limits:     { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─── AUTH MIDDLEWARE ───
export const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Sin token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
};

// ─── GET PROFILE ───
export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    const posts = await Post.find({ user: req.params.id }).sort({ createdAt: -1 });
    res.json({ user, posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── UPDATE PROFILE ───
export const updateProfile = async (req, res) => {
  try {
    const allowedFields = [
      "name", "username", "bio",
      "phone", "whatsapp", "contactEmail",
      "location", "theme",
    ];

    const update = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    }

    if (req.body.customStyles) {
      try {
        update.customStyles = JSON.parse(req.body.customStyles);
      } catch {
        return res.status(400).json({ error: "customStyles JSON inválido" });
      }
    }

    // ── Avatar ──
    if (req.files?.avatar?.[0]) {
      const existing = await User.findById(req.user.id).select("avatarId");
      if (existing?.avatarId) {
        await cloudinary.uploader.destroy(existing.avatarId, { resource_type: "image" });
      }
      update.avatar   = req.files.avatar[0].path;
      update.avatarId = req.files.avatar[0].filename;
    }

    // ── Banner ──
    if (req.files?.banner?.[0]) {
      const existing = await User.findById(req.user.id).select("bannerId");
      if (existing?.bannerId) {
        await cloudinary.uploader.destroy(existing.bannerId, { resource_type: "image" });
      }
      update.banner   = req.files.banner[0].path;
      update.bannerId = req.files.banner[0].filename;
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true, runValidators: true }
    ).select("-password");

    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    res.json({ user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Ese nombre de usuario ya está en uso" });
    }
    res.status(500).json({ error: err.message });
  }
};

// ─── CHANGE PASSWORD ───
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Ambas contraseñas son requeridas" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: "Contraseña actual incorrecta" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Contraseña actualizada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── SUBSCRIBE / UNSUBSCRIBE ───
export const toggleSubscribe = async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "No podés suscribirte a vos mismo" });
    }

    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado" });

    const isSubbed = target.subscribers.some(
      (s) => s.toString() === req.user.id
    );

    if (isSubbed) {
      target.subscribers = target.subscribers.filter(
        (s) => s.toString() !== req.user.id
      );
    } else {
      target.subscribers.push(req.user.id);
    }

    await target.save();
    res.json({ subscribed: !isSubbed, count: target.subscribers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── LIKE / UNLIKE POST ───
export const toggleLike = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post no encontrado" });

    const liked = post.likes.some((l) => l.toString() === req.user.id);

    if (liked) {
      post.likes = post.likes.filter((l) => l.toString() !== req.user.id);
    } else {
      post.likes.push(req.user.id);
    }

    await post.save();
    res.json({ liked: !liked, count: post.likes.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── CREATE POST ───
export const createPost = async (req, res) => {
  try {
    const { type, title, description, url } = req.body;
    const thumbnail = req.file
      ? req.file.path               // URL de Cloudinary
      : "/images/preview.png";

    const post = await Post.create({
      user: req.user.id,
      type,
      title,
      description,
      url,
      thumbnail,
    });

    res.status(201).json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ─── DELETE POST ───
export const deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post no encontrado" });
    if (post.user.toString() !== req.user.id) {
      return res.status(403).json({ error: "Sin permiso" });
    }
    await post.deleteOne();
    res.json({ message: "Eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};