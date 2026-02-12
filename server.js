// server.js - Servidor WebSocket robusto para overlay de chat Twitch e Kick
// Suporte a múltiplos canais: Clients enviam 'join' com platform e channel.
// Server subscreve dinamicamente e broadcasta mensagens para rooms específicas.
// Ping/pong para evitar timeouts. Health check para Render.
// Dependências: ws, express, tmi.js, axios

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const tmi = require('tmi.js');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===============================
// CONFIGURAÇÕES
// ===============================
const TWITCH_BOT_USERNAME = 'xyzgx';
const TWITCH_OAUTH_TOKEN = 'oauth:SEU_TOKEN_AQUI'; // IMPORTANTE: precisa começar com oauth:

// ===============================
// ROTAS PARA RENDER / UPTIMEROBOT
// ===============================

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Rota principal
app.get('/', (req, res) => {
  res.status(200).send('Server is running');
});

// ===============================
// MAPAS DE CONTROLE
// ===============================
const channels = new Map();
const twitchChannels = new Set();
const kickConnections = new Map();

// ===============================
// CLIENT TWITCH (join dinâmico)
// ===============================
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN
  },
  channels: []
});

twitchClient.connect();

// ===============================
// WEBSOCKET
// ===============================
const PING_INTERVAL = 30000;

wss.on('connection', (ws) => {
  console.log('Novo client conectado');
  ws.isAlive = true;
  ws.rooms = new Set();

  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.action === 'join') {
        const { platform, channel } = data;
        if (!platform || !channel) return;

        const lowerChannel = channel.toLowerCase();
        const roomKey = `${platform}-${lowerChannel}`;

        if (!channels.has(roomKey)) channels.set(roomKey, new Set());
        channels.get(roomKey).add(ws);
        ws.rooms.add(roomKey);

        console.log(`Client joined room: ${roomKey}`);

        if (platform === 'twitch' && !twitchChannels.has(lowerChannel)) {
          await twitchClient.join(lowerChannel);
          twitchChannels.add(lowerChannel);
          console.log(`Joined Twitch channel: ${lowerChannel}`);
        }

        ws.send(JSON.stringify({ status: 'joined', room: roomKey }));
      }

    } catch (error) {
      console.error('Erro no message:', error);
    }
  });

  ws.on('close', () => {
    ws.rooms.forEach(room => {
      if (channels.has(room)) {
        channels.get(room).delete(ws);
        if (channels.get(room).size === 0) {
          channels.delete(room);
        }
      }
    });
  });
});

// ===============================
// PING / PONG
// ===============================
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

server.on('close', () => clearInterval(interval));

// ===============================
// TWITCH EVENTS
// ===============================
twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;

  const roomKey = `twitch-${channel.replace('#','').toLowerCase()}`;
  if (!channels.has(roomKey)) return;

  broadcastToRoom(roomKey, {
    user: tags['display-name'],
    message,
    userId: tags['user-id'],
    msgId: tags.id,
    platform: 'twitch'
  });
});

twitchClient.on('deletemessage', (channel, msgid) => {
  const roomKey = `twitch-${channel.replace('#','').toLowerCase()}`;
  if (!channels.has(roomKey)) return;

  broadcastToRoom(roomKey, { type: 'delete-message', msgId: msgid });
});

// ===============================
// BROADCAST
// ===============================
function broadcastToRoom(roomKey, data) {
  if (!channels.has(roomKey)) return;

  channels.get(roomKey).forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ===============================
// PORTA
// ===============================
const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Server rodando na porta ${PORT}`);
});
