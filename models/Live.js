import mongoose from "mongoose";

const liveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, maxlength: 80 },
    description: { type: String, maxlength: 300, default: "" },
    category: { type: String, default: "" },
    thumbnail: { type: String, default: "" },       // Cloudinary URL
    thumbnailPublicId: { type: String, default: "" },

    status: {
      type: String,
      enum: ["waiting", "live", "ended"],
      default: "waiting",
    },

    isPrivate: { type: Boolean, default: false },
    allowedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    scheduledAt: { type: Date, default: null },     // null = sin programar

    streamKey: { type: String, unique: true, sparse: true },

    vodUrl: { type: String, default: "" },          // Cloudinary URL tras finalizar
    vodPublicId: { type: String, default: "" },

    viewerCount: { type: Number, default: 0 },
    peakViewers: { type: Number, default: 0 },

    startedAt: { type: Date },
    endedAt:   { type: Date },

    giftStats: { type: Map, of: Number, default: {} },
  },
  { timestamps: true }
);

liveSchema.index({ status: 1, scheduledAt: 1 });
liveSchema.index({ user: 1 });

export default mongoose.model("Live", liveSchema);