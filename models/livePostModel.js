// models/livePostModel.js
import mongoose from "mongoose";

const giftSchema = new mongoose.Schema({
  from:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  fromName: String,
  type:     { type: String, default: "corazon" },
  amount:   { type: Number, default: 1 },
  message:  String,
  at:       { type: Date, default: Date.now },
});

const liveSchema = new mongoose.Schema({
  user:        { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title:       { type: String, required: true, maxlength: 100 },
  description: { type: String, maxlength: 500 },
  category:    { type: String, default: "general" },
  thumbnail:   { type: String, default: "/images/preview.png" },
  thumbnailId: String,

  // Streaming
  streamKey:  { type: String, unique: true },
  rtmpUrl:    String,
  hlsUrl:     String,
  webrtcUrl:  String,
  vodUrl:     String,
  vodPublicId: String,

  // Estado
  status:     { type: String, enum: ["waiting","live","ended"], default: "waiting" },
  scheduled:  Date,
  startedAt:  Date,
  endedAt:    Date,

  // Stats
  peakViewers:  { type: Number, default: 0 },
  totalViewers: { type: Number, default: 0 },
  totalGifts:   { type: Number, default: 0 },

  // Regalos
  gifts: [giftSchema],
}, { timestamps: true });

export default mongoose.models.LivePost || mongoose.model("LivePost", liveSchema);