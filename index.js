const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// 🔹 Conexión MongoDB
mongoose
  .connect('mongodb://104.192.5.79:27017/chat_tokens', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ Conectado a MongoDB'))
  .catch((err) => console.error(' Error al conectar a MongoDB:', err));

// 🔹 Esquema y modelo genérico
const TokenSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  token: { type: String, required: true }, 
  linkKey: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});

const TokenModel = mongoose.model('Token', TokenSchema);

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: '*' },
});

// 🔹 Historial en memoria (temporal)
const chatHistory = {}; // { linkKey: [mensajes...] }

// 🔹 Función auxiliar para enviar notificación
async function sendPushNotification(token, title, body,linkKey) {
  try {
    if (!token) {
      console.log('⚠️ No se proporcionó token');
      return;
    }
    console.log("token enviado:",token);
    
        const messageData = {
      ...body,
      linkKey: linkKey || '', // incluir linkKey
    };


    if (token.startsWith('ExponentPushToken')) {
      // ---- Expo Push ----
      const message = {
        to: token,
        sound: 'default',
        title,
        body,
        data: { mensaje: body },
      };

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      const data = await response.json();
      console.log('📨 Notificación (Expo):', data);
    } else {
      // ---- Firebase FCM ----
      const message = {
        token,
        notification: {
          mensaje: JSON.stringify(messageData),
          title: 'Hola, tienes un mensaje',    
          body: messageData.text,      
        } ,
         data: {
          mensaje: JSON.stringify(messageData),
          title: 'Hola, tienes un mensaje',    
          body: messageData.text,      
        }        
      };

      const response = await admin.messaging().send(message);
      console.log(' Notificación (FCM):', response);
    }
  } catch (error) {
    console.error(' Error al enviar notificación:', error);
  }
}

/*async function sendPushNotification(expoPushToken, title, body) {
  if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken')) {
    console.log('⚠️ Token inválido o ausente:', expoPushToken);
    return;
  }

  const message = {
    to: expoPushToken,
    sound: 'default',
    title,
    body,
    data: { mensaje: body },
  };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const data = await response.json();
    console.log('📨 Notificación enviada:', data);
  } catch (error) {
    console.error('Error al enviar push:', error);
  }
} */

// 🔹 Endpoint para registrar/actualizar token
app.post('/api/register-token', async (req, res) => {
  const { userId, token ,linkKey} = req.body;

  if (!userId || !token) {
    return res.status(400).json({ error: 'userId y token son requeridos' });
  }

  try {
    const existing = await TokenModel.findOne({ userId });

   /* if (existing) {
      existing.token = token;
      existing.linkKey = linkKey;
      existing.updatedAt = new Date();
      await existing.save();
      console.log(`🔁 Token actualizado para ${userId}`);
    } else {
      await TokenModel.create({ userId, token ,linkKey});
      console.log(`🆕 Token registrado para ${userId}`);
    }
    */
    await TokenModel.create({ userId, token ,linkKey});
      console.log(`🆕 Token registrado para ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error al registrar token:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// 🔹 Endpoint manual para probar envío directo
app.post('/api/send-notification', async (req, res) => {
  const { token, title, body,linkKey } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ message: 'Faltan token, title o body' });
  }

  try {
    await sendPushNotification(token, title, body,linkkey);
    res.json({ message: '✅ Notificación enviada correctamente' });
  } catch (error) {
    console.error('❌ Error al enviar notificación:', error);
    res.status(500).json({ message: 'Error al enviar notificación', error });
  }
});

// 🔹 Socket.IO
io.on('connection', (socket) => {
  console.log('🔹 Cliente conectado:', socket.id);

  socket.on('joinChat', (linkKey) => {
    socket.join(linkKey);
    console.log(`💬 ${socket.id} se unió a la sala ${linkKey}`);

    if (chatHistory[linkKey]) {
      socket.emit('chatHistory', chatHistory[linkKey]);
    } else {
      chatHistory[linkKey] = [];
    }
  });

  socket.on('sendMessage', async ({ linkKey, message, to }) => {
    console.log('📨 Mensaje recibido:', message, 'para:', to);

    if (!chatHistory[linkKey]) chatHistory[linkKey] = [];
    chatHistory[linkKey].push(message);

    io.to(linkKey).emit('receiveMessage', message);

    try {
      console.log("linkKey",linkKey);
       const recipients = await TokenModel.find({
      linkKey,
      userId: { $ne: message.sender } // <-- excluir el sender
    });
 
      if (recipients && recipients.length > 0) {

        console.log("recipients.length ",recipients.length );
          
              for (const recipient_ of recipients) {
                console.log("Enviando notificación a token:", recipient_.token);
                await sendPushNotification(
                  recipient_.token,
                  'Nuevo mensaje  privado💬',
                  message,
                  linkKey
                );
          }
      } else {
        console.log(`⚠️ No hay token registrado para ${to}`);
      }
    } catch (error) {
      console.error('❌ Error al enviar notificación:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado:', socket.id);
  });
});

// 🔹 Endpoint de prueba
app.get('/', (req, res) => {
  res.send('Servidor de chat con notificaciones push activo ✅');
});

// 🔹 Iniciar servidor
const PORT = 3100;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
