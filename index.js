// index.js  ← solo cambiás este comentario
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

import authRoutes    from "./routes/authRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import uploadRoutes  from "./routes/uploadRoutes.js";
import feedRoutes    from "./routes/feedRoutes.js";
import shareRoutes   from "./routes/shareRoutes.js";
import liveRoutes    from "./routes/liveRoutes.js";

import { setupLiveSocket } from "./socket/liveSocket.js";
import superAdminRoutes from "./routes/superAdminRoutes.js";


dotenv.config();

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  },
});

app.locals.io = io;
setupLiveSocket(io);

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000", credentials: true }));
app.use(express.json());

app.use("/api/auth",    authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/upload",  uploadRoutes);
app.use("/api/feed",    feedRoutes);
app.use("/api/live",    liveRoutes);
app.use("/api/share",   shareRoutes);
app.use("/uploads", express.static("public/uploads"));
app.use("/api/superadmin", superAdminRoutes);

app.get("/", (req, res) => {
  const dbState = mongoose.connection.readyState;

  const states = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };

  res.status(200).json({
    status: "ok",
    server: "running",
    database: states[dbState],
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("DB conectada"))
  .catch((err) => console.log(err));

httpServer.listen(4000, () => {
  console.log("Server + Socket.io corriendo en :4000");
});