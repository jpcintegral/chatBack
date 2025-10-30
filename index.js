const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' } // permite conexiones desde cualquier cliente
});

// 🔹 Almacenamiento temporal de chats
// key: linkKey, value: array de mensajes
const chatHistory = {};

io.on('connection', (socket) => {
  console.log('🔹 Cliente conectado:', socket.id);

  // 🔹 Unirse a una sala de chat por linkKey
  socket.on('joinChat', (linkKey) => {
    socket.join(linkKey);
    console.log(`🟢 ${socket.id} se unió a la sala ${linkKey}`);

    // Enviar historial al cliente
    if (chatHistory[linkKey]) {
      socket.emit('chatHistory', chatHistory[linkKey]);
    } else {
      chatHistory[linkKey] = [];
    }
  });

  // 🔹 Enviar mensaje a todos los clientes de la misma sala
  socket.on('sendMessage', ({ linkKey, message }) => {

      console.log("linkKey",linkKey);
      console.log("message",message);
  
    // Guardar en historial
    if (!chatHistory[linkKey]) chatHistory[linkKey] = [];
    chatHistory[linkKey].push(message);

    // Enviar a todos los que están en la sala
    io.to(linkKey).emit('receiveMessage', message);
  });

  socket.on('disconnect', () => {
    console.log(' Cliente desconectado:', socket.id);
  });
});

// 🔹 Endpoint de prueba
app.get('/', (req, res) => {
  res.send('Servidor de chat en tiempo real activo ✅');
});

// 🔹 Arrancar servidor
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
