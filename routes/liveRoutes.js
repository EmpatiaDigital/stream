import express from "express";
import multer from "multer";
import { authMiddleware } from "../middleware/auth.js";
import {
  createLive, getLive, listLives, getActiveLives, updateLive, endLive,
  deleteLive, uploadThumbnail, getMyLives, sendGift, getGiftBalance, buyGifts,
} from "../controllers/liveController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ── Pública sin auth (navbar la usa sin token) ────────────────────────
router.get("/active", getActiveLives);        

// ── Con auth ──────────────────────────────────────────────────────────
router.get("/",                authMiddleware, listLives);
router.get("/my",              authMiddleware, getMyLives);
router.get("/gifts/balance",   authMiddleware, getGiftBalance);
router.post("/gifts/buy",      authMiddleware, buyGifts);
router.get("/:liveId",         authMiddleware, getLive);
router.post("/:liveId/gift",   authMiddleware, sendGift);
router.post("/",               authMiddleware, createLive);
router.put("/:liveId",         authMiddleware, updateLive);
router.post("/:liveId/end",    authMiddleware, endLive);
router.delete("/:liveId",      authMiddleware, deleteLive);
router.post("/:liveId/thumbnail", authMiddleware, upload.single("thumbnail"), uploadThumbnail);

export default router;