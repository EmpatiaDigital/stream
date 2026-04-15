import express from "express";
import User from "../models/userModel.js";
import Post from "../models/postModel.js";
import Live from "../models/livePostModel.js";

import { authMiddleware } from "../middleware/auth.js";
import { superAdminOnly } from "../middleware/superAdmin.js";

const router = express.Router();

// ── USERS ──────────────────────────────────────────────────────────

router.get("/users", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ msg: "Error al obtener usuarios" });
  }
});

router.put("/users/:id/freeze", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    if (user.role === "superadmin") return res.status(403).json({ msg: "No podés congelar a un superadmin" });

    user.isFrozen = true;
    user.frozenReason = reason || "Sin motivo";
    await user.save();
    res.json(user);
  } catch (err) {
    res.status(500).json({ msg: "Error al congelar" });
  }
});

router.put("/users/:id/unfreeze", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });

    user.isFrozen = false;
    user.frozenReason = "";
    await user.save();
    res.json(user);
  } catch (err) {
    res.status(500).json({ msg: "Error al descongelar" });
  }
});

router.delete("/users/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    if (user.role === "superadmin") return res.status(403).json({ msg: "No podés eliminar a un superadmin" });

    await Post.deleteMany({ user: user._id });
    await Live.deleteMany({ user: user._id });
    await User.findByIdAndDelete(user._id);
    res.json({ msg: "Usuario eliminado completamente" });
  } catch (err) {
    res.status(500).json({ msg: "Error al eliminar usuario" });
  }
});

router.put("/users/:id/plan", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { plan, durationDays } = req.body;
    const validPlans = ["free", "pro", "premium"];
    if (!validPlans.includes(plan)) return res.status(400).json({ msg: "Plan inválido" });

    let planExpiresAt = null;
    if (plan !== "free" && durationDays) {
      planExpiresAt = new Date();
      planExpiresAt.setDate(planExpiresAt.getDate() + durationDays);
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { plan, planExpiresAt },
      { new: true }
    );
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ msg: "Error al cambiar plan" });
  }
});

router.put("/users/:id/role", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ["user", "admin"];  // superadmin no se puede asignar desde acá
    if (!validRoles.includes(role)) return res.status(400).json({ msg: "Rol inválido" });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    );
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ msg: "Error al cambiar rol" });
  }
});

// ── POSTS ──────────────────────────────────────────────────────────

router.get("/posts", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const posts = await Post.find()
      .populate("user", "name email")
      .sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ msg: "Error al obtener posts" });
  }
});

router.delete("/posts/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const post = await Post.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ msg: "Post no encontrado" });
    res.json({ msg: "Post eliminado" });
  } catch (err) {
    res.status(500).json({ msg: "Error al eliminar post" });
  }
});

// ── LIVES ──────────────────────────────────────────────────────────

router.get("/lives", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const lives = await Live.find()
      .populate("user", "name email")
      .sort({ createdAt: -1 });
    res.json(lives);
  } catch (err) {
    res.status(500).json({ msg: "Error al obtener lives" });
  }
});

router.delete("/lives/:id", authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const live = await Live.findByIdAndDelete(req.params.id);
    if (!live) return res.status(404).json({ msg: "Live no encontrado" });
    res.json({ msg: "Live eliminado" });
  } catch (err) {
    res.status(500).json({ msg: "Error al eliminar live" });
  }
});

export default router;