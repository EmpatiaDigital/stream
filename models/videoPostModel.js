// models/videoPostModel.js
import mongoose from "mongoose";
import Post from "./postModel.js";

const { Schema } = mongoose;

// ─── VIDEO POST ───
// Extiende Post con: categoría
// El campo `type` valdrá automáticamente "VideoPost"
const VideoPostSchema = new Schema({
  category: {
    type:    String,
    enum:    ["Talento Libre", "Canto", "Baile", "El humor", "Música", "Arte"],
    default: "Talento Libre",
  },
});

const VideoPost = Post.discriminator("video", VideoPostSchema);

export default VideoPost;