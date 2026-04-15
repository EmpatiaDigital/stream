// models/photoPostModel.js
import mongoose from "mongoose";
import Post from "./postModel.js";

const { Schema } = mongoose;

// ─── PHOTO POST ───
// Extiende Post con: galería de imágenes y categoría de arte
// El campo `type` valdrá automáticamente "photo"
const PhotoPostSchema = new Schema({
  // Imágenes adicionales a la thumbnail principal
  // (para galerías con varias fotos en un mismo post)
  images: [
    {
      url:        { type: String, required: true },
      publicId:   { type: String },               // Cloudinary public_id para poder borrarla
      caption:    { type: String, default: "" },   // descripción individual de cada foto
    },
  ],

  // Categoría opcional para clasificar el tipo de arte / foto
  category: {
    type:    String,
    enum:    ["Fotografía", "Ilustración", "Pintura", "Diseño", "Escultura", "Otro"],
    default: "Fotografía",
  },
});

const PhotoPost = Post.discriminator("photo", PhotoPostSchema);

export default PhotoPost;