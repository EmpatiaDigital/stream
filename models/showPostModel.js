// models/showPostModel.js
import mongoose from "mongoose";
import Post from "./postModel.js";

const { Schema } = mongoose;

// ─── SHOW POST ───
// Extiende Post con: fecha, lugar, precio y capacidad
// El campo `type` valdrá automáticamente "show"
const ShowPostSchema = new Schema({
  // ── Fecha y hora del evento ──
  eventDate: {
    type:     Date,
    required: true,
  },

  // ── Ubicación / lugar ──
  location: {
    venue:    { type: String, required: true, trim: true },   // nombre del lugar
    address:  { type: String, default: "",    trim: true },   // dirección completa
    city:     { type: String, default: "",    trim: true },
    province: { type: String, default: "",    trim: true },
  },

  // ── Precio de entrada ──
  ticketPrice: {
    type:    Number,
    min:     0,
    default: 0,          // 0 = entrada gratuita
  },
  currency: {
    type:    String,
    enum:    ["ARS", "USD"],
    default: "ARS",
  },
  isFree: {
    type:    Boolean,
    default: false,
  },

  // ── Capacidad máxima ──
  capacity: {
    type: Number,
    min:  1,
  },

  // ── Estado del show ──
  status: {
    type:    String,
    enum:    ["upcoming", "ongoing", "finished", "cancelled"],
    default: "upcoming",
  },

  // ── Link externo de tickets (opcional) ──
  ticketUrl: {
    type: String,
    default: "",
  },
});

// Índice para buscar shows próximos por fecha
ShowPostSchema.index({ eventDate: 1 });
ShowPostSchema.index({ "location.city": 1, eventDate: 1 });

const ShowPost = Post.discriminator("show", ShowPostSchema);

export default ShowPost;