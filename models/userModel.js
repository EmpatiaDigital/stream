// models/userModel.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: "normal" },

    // Profile
    username: { type: String, unique: true, sparse: true },
    bio: { type: String, default: "" },
    avatar: { type: String, default: "/images/preview.png" },
    banner: { type: String, default: "/images/preview.png" },
    phone: { type: String, default: "" },
    whatsapp: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    location: { type: String, default: "" },
    avatarId: { type: String, default: null },
    bannerId: { type: String, default: null },
    // Theme
    theme: { type: String, default: "theme1" },
    customStyles: { type: Object, default: {} },
    giftBalance: {
      corazon: { type: Number, default: 10 },
      estrella: { type: Number, default: 10 },
      fuego: { type: Number, default: 10 },
      diamante: { type: Number, default: 5 },
      corona: { type: Number, default: 5 },
      cohete: { type: Number, default: 3 },
    },

    // Social
    subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true },
);

export default mongoose.models.User || mongoose.model("User", userSchema);
