// routes/profileRoutes.js
import express from "express";
import {
  getProfile,
  updateProfile,
  changePassword,
  toggleSubscribe,
  toggleLike,
  createPost,
  deletePost,
  authMiddleware,
  upload,
} from "../controllers/profileController.js";

const router = express.Router();

// ─── IMPORTANT: Static routes MUST come before /:id ───
// Otherwise Express would match "update" and "password" as an id param.

router.put(
  "/update",
  authMiddleware,
  upload.fields([{ name: "avatar", maxCount: 1 }, { name: "banner", maxCount: 1 }]),
  updateProfile
);

router.put("/password", authMiddleware, changePassword);

router.post(
  "/post",
  authMiddleware,
  upload.single("thumbnail"),
  createPost
);

router.post("/post/:postId/like", authMiddleware, toggleLike);

router.delete("/post/:postId", authMiddleware, deletePost);

// ─── Dynamic routes last ───
router.get("/:id", getProfile);
router.post("/:id/subscribe", authMiddleware, toggleSubscribe);

export default router;