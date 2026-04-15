// models/postModel.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

// ─── SCHEMA BASE ───
// Campos compartidos por Video, Photo y Show
const baseOptions = {
  discriminatorKey: "type",   // el campo que distingue el subtipo
  collection:       "posts",  // todos en la misma colección
  timestamps:       true,
};

const PostSchema = new Schema(
  {
    user: {
      type:     Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },
    title: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 100,
    },
    description: {
      type:      String,
      default:   "",
      maxlength: 500,
    },
    url: {
      type: String,
      default: "",
    },
    thumbnail: {
      type:    String,
      default: "/images/preview.png",
    },
    thumbnailId: {
      type: String,
    },
    cloudinaryId: {
      type: String,
    },
    likes: [
      {
        type: Schema.Types.ObjectId,
        ref:  "User",
      },
    ],
  },
  baseOptions
);

// Índices útiles para el feed
PostSchema.index({ createdAt: -1 });
PostSchema.index({ user: 1, createdAt: -1 });

const Post = model("Post", PostSchema);

export default Post;