const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-service-account.json");
const ChatMessage = require("./models/hatMessage.model");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// 🔹 Conexión MongoDB
mongoose
  .connect("mongodb://104.192.5.79:27017/chat_tokens", {
    //.connect("mongodb://localhost/chat_tokens", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Conectado a MongoDB"))
  .catch((err) => console.error(" Error al conectar a MongoDB:", err));

// 🔹 Esquema y modelo genérico
const TokenSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  token: { type: String, required: true },
  linkKey: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const TokenModel = mongoose.model("Token", TokenSchema);

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*" },
});

// 🔹 Historial en memoria (temporal)
const chatHistory = {}; // { linkKey: [mensajes...] }
const onlineUsers = {};
const activeChatUsers = {}; // { linkKey: Set(deviceIds) }

// 🔹 Función auxiliar para enviar notificación
async function sendPushNotification(token, title, body, linkKey) {
  try {
    if (!token) {
      console.log(" No se proporcionó token");
      return;
    }
    console.log("token enviado:", token);

    const messageData = {
      ...body,
      linkKey: linkKey || "", // incluir linkKey
    };

    if (token.startsWith("ExponentPushToken")) {
      // ---- Expo Push ----
      const message = {
        to: token,
        sound: "default",
        title,
        body,
        data: { mensaje: body },
      };

      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      const data = await response.json();
      console.log(" Notificación (Expo):", data);
    } else {
      // ---- Firebase FCM ----
      const message = {
        token,
        notification: {
          title: "Hola, tienes un mensaje",
          body: messageData.text,
        },
        data: {
          mensaje: JSON.stringify(messageData),
          title: "Hola, tienes un mensaje",
          body: messageData.text,
        },
      };

      const response = await admin.messaging().send(message);
      console.log(" Notificación (FCM):", response);
    }
  } catch (error) {
    console.error(" Error al enviar notificación:", error);
  }
}

// 🔹 Endpoint para registrar/actualizar token
app.post("/api/register-token", async (req, res) => {
  const { userId, token, linkKey } = req.body;

  if (!userId || !token) {
    return res.status(400).json({ error: "userId y token son requeridos" });
  }

  try {
    const existing = await TokenModel.findOne({ userId });

    await TokenModel.create({ userId, token, linkKey });
    console.log(` Token registrado para ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(" Error al registrar token:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 🔹 Endpoint manual para probar envío directo
app.post("/api/send-notification", async (req, res) => {
  const { token, title, body, linkKey } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ message: "Faltan token, title o body" });
  }

  try {
    await sendPushNotification(token, title, body, linkkey);
    res.json({ message: " Notificación enviada correctamente" });
  } catch (error) {
    console.error(" Error al enviar notificación:", error);
    res.status(500).json({ message: "Error al enviar notificación", error });
  }
});

// 🔹 Socket.IO
io.on("connection", (socket) => {
  console.log("🔹 Cliente conectado:", socket.id);

  socket.on("joinChat", ({ linkKey, deviceId }) => {
    if (!linkKey || !deviceId) {
      return;
    }
    socket.join(linkKey);
    socket.currentChat = linkKey;
    socket.deviceId = deviceId;
    if (!activeChatUsers[linkKey]) {
      activeChatUsers[linkKey] = new Set();
    }

    activeChatUsers[linkKey].add(deviceId);
    console.log("Usuarios", activeChatUsers);
    io.to(linkKey).emit("activeUsers", [...activeChatUsers[linkKey]]);
  });

  // ---------------------------------------------
  //  El usuario se une a su sala personal
  // ---------------------------------------------
  socket.on("joinUser", (userId) => {
    socket.userId = userId;
    onlineUsers[userId] = true;
    socket.join(`${userId}`);
    console.log(`Usuario ${userId} conectado`);

    //io.emit("userStatus", { userId, status: "online" });
    io.emit("userStatus", onlineUsers);
  });

  socket.on("sendMessage", async ({ linkKey, message, sender, to }) => {
    //console.log(" Mensaje recibido:", message, "para:", to);

    if (!chatHistory[linkKey]) chatHistory[linkKey] = [];
    chatHistory[linkKey].push(message);

    try {
      await ChatMessage.updateOne(
        { id: message.id }, // evitar duplicados
        { ...message, linkKey },
        { upsert: true }
      );
    } catch (err) {
      console.error("❌ Error guardando mensaje:", err);
    }
    io.to(linkKey).emit("receiveMessage", {
      ...message,
      linkKey,
    });

    io.to(linkKey).emit("chatListUpdate", {
      linkKey,
      lastMessage: message.text,
      timestamp: message.timestamp,
      sender: message.sender,
    });

    try {
      console.log("linkKey", linkKey);
      const recipients = await TokenModel.find({
        linkKey,
        userId: { $ne: message.sender }, // <-- excluir el sender
      });

      if (recipients && recipients.length > 0) {
        console.log("recipients.length ", recipients.length);

        for (const recipient_ of recipients) {
          console.log("Enviando notificación a token:", recipient_.token);
          await sendPushNotification(
            recipient_.token,
            "Nuevo mensaje  privado",
            message,
            linkKey
          );
        }
      } else {
        console.log(` No hay token registrado para ${to}`);
      }
    } catch (error) {
      console.error(" Error al enviar notificación:", error);
    }
  });

  socket.on("requestChatHistory", async ({ linkKey, userId }) => {
    try {
      console.log("Cargando historial para linkKey:", linkKey);
      console.log("userId:", userId);
      const messages = await ChatMessage.find({ linkKey })
        .sort({ createdAt: 1 })
        .lean();

      // 🔒 Solo devolver mensajes donde el usuario participe
      /*const filtered = messages.filter(
        (msg) => msg.sender === userId || msg.to === userId
      );*/
      const filtered = messages.filter(
        (msg) => msg.linkKey === linkKey || msg.to === userId
      );
      console.log("Mensajes filtrados:", filtered.length);
      socket.emit("chatHistoryResponse", {
        linkKey,
        messages: filtered,
      });
    } catch (err) {
      console.error("❌ Error cargando historial:", err);
    }
  });

  socket.on("requestChatListHistory", async (userId) => {
    try {
      const allMessages = await ChatMessage.find({
        $or: [{ sender: userId }, { to: userId }],
      })
        .sort({ createdAt: -1 })
        .lean();

      const grouped = {};

      for (const msg of allMessages) {
        if (!grouped[msg.linkKey]) {
          grouped[msg.linkKey] = msg; // El más reciente
        }
      }

      socket.emit("chatListHistoryResponse", grouped);
    } catch (err) {
      console.error("❌ Error en ChatListHistory:", err);
    }
  });

  // --- Delete multiple messages ---
  socket.on("deleteMessages", async ({ linkKey, messageIds }) => {
    try {
      console.log(" Eliminando mensajes:", messageIds);

      if (!linkKey || !Array.isArray(messageIds) || messageIds.length === 0) {
        console.warn(" Parámetros inválidos en deleteMessages");
        return;
      }

      // 👉 Eliminar de MongoDB
      const result = await ChatMessage.deleteMany({
        linkKey: linkKey,
        id: { $in: messageIds },
      });

      console.log(` Mensajes eliminados en MongoDB: ${result.deletedCount}`);

      // 👉 Notificar a todos los usuarios conectados en ese chat
      io.to(linkKey).emit("messagesDeleted", { messageIds });
    } catch (error) {
      console.error(" Error eliminando mensajes:", error);
    }
  });

  socket.on("requestContactDeviceId", async ({ linkKey, myDeviceId }) => {
    const otherUser = await TokenModel.findOne({
      linkKey,
      userId: { $ne: myDeviceId },
    });
    // console.log("otherUser:", otherUser);
    if (otherUser) {
      socket.emit("contactDeviceId", {
        deviceId: otherUser.userId,
        linkKey: linkKey,
      });
    }
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      console.log(" Usuario desconectado:", socket.userId);
      onlineUsers[socket.userId] = false;
      io.emit("userStatus", onlineUsers);
      console.log(`Usuario ${socket.userId} desconectado`);
    }

    if (socket.currentChat && socket.userId) {
      const linkKey = socket.currentChat;
      activeChatUsers[linkKey]?.delete(socket.deviceId);
      io.to(linkKey).emit("activeUsers", [...activeChatUsers[linkKey]]);
    }

    console.log(" Cliente desconectado:", socket.id);
  });
});

// 🔹 Endpoint de prueba
app.get("/", (req, res) => {
  res.send("Servidor de chat con notificaciones push activo ✅");
});

// 🔹 Iniciar servidor
const PORT = 3100;
server.listen(PORT, "0.0.0.0", () => {
  console.log(` Servidor corriendo en http://localhost:${PORT}`);
});
