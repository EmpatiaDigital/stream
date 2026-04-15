// routes/feedRoutes.js
import express from "express";
import { getFeed, incrementView } from "../controllers/feedController.js";

const router = express.Router();

// GET /api/feed?category=Baile&sort=trending&page=1&limit=12
router.get("/", getFeed);

// POST /api/feed/view/:postId  — incrementar vistas (sin auth)
router.post("/view/:postId", incrementView);

export default router;