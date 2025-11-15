const mongoose = require("mongoose");

const ChatMessageSchema = new mongoose.Schema(
  {
    linkKey: { type: String, required: true, index: true },
    id: { type: String, required: true, unique: true }, // ID del mensaje (lo genera el front)
    sender: String,
    text: String,
    timestamp: Number,
    type: String, // opcional (text, image, etc)
  },
  {
    timestamps: true,
  },
);

// Auto-borrado por TTL (ej: 30 días)
ChatMessageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 },
);

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);
