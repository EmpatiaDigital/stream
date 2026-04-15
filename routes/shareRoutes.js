import express from "express";
import { getSharePage, getPostById } from "../controllers/shareController.js";

const router = express.Router();

// Página de compartir con OG tags → redirige al front
router.get("/:postId", getSharePage);

// API pura para el front
router.get("/post/:postId", getPostById);

export default router;