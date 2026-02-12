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

// Configs - Mude para seus valores
const TWITCH_BOT_USERNAME = 'xyzgx'; // Username do bot Twitch
const TWITCH_OAUTH_TOKEN = 'o731um0ljm4od6av2hp0ohoa1t8v32'; // Gere em https://twitchapps.com/tmi/

// Mapas para gerenciamento
const channels = new Map(); // roomKey (platform-channel) => Set de clients WS
const twitchChannels = new Set(); // Canais Twitch subscritos
const kickConnections = new Map(); // channel => { ws: WebSocket, chatroomId: string, userId: string }
const kickEmotes = new Map(); // channel => array de emotes 7TV

// Client Twitch (tmi.js) - Conecta uma vez, join dinâmico
const twitchClient = new tmi.Client({
  options: { debug: true },
  identity: {
    username: TWITCH_BOT_USERNAME,
    password: TWITCH_OAUTH_TOKEN
  },
  channels: [] // Inicia vazio, join dinâmico
});
twitchClient.connect();

// Health check para Render
app.get('/health', (req, res) => res.status(200).send('OK'));

// Ping/pong config
const PING_INTERVAL = 30000;
wss.on('connection', (ws) => {
  console.log('Novo client conectado');
  ws.isAlive = true;
  ws.rooms = new Set(); // Rooms joined

  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'join') {
        const { platform, channel } = data;
        if (!platform || !channel) return;
        const roomKey = `${platform}-${channel.toLowerCase()}`;
        if (!channels.has(roomKey)) channels.set(roomKey, new Set());
        channels.get(roomKey).add(ws);
        ws.rooms.add(roomKey);
        console.log(`Client joined room: ${roomKey}`);

        // Subscribe se não já
        if (platform === 'twitch' && !twitchChannels.has(channel)) {
          twitchClient.join(channel);
          twitchChannels.add(channel);
          console.log(`Joined Twitch channel: ${channel}`);
        } else if (platform === 'kick' && !kickConnections.has(channel)) {
          // Fetch chatroom ID para Kick
          const response = await axios.get(`https://mrboostlive.com/kick/api/?channel=${channel}`);
          const { chatroom: { id: chatroomId }, id: userId } = response.data;
          // Connect WS para esse Kick channel
          const kickWs = new WebSocket("wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false");
          kickWs.onopen = () => {
            kickWs.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${chatroomId}.v2` } }));
            kickWs.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `channel.${userId}` } }));
            console.log(`Joined Kick channel: ${channel}`);
          };
          kickWs.onmessage = (ev) => handleKickMessage(ev, channel);
          kickWs.onclose = () => {
            console.log(`Kick WS closed for ${channel}, reconnecting...`);
            setTimeout(() => subscribeKickChannel(channel), 1000);
          };
          kickConnections.set(channel, { ws: kickWs, chatroomId, userId });
          // Fetch 7TV emotes (mas como processamos no client, opcional aqui)
        }
        ws.send(JSON.stringify({ status: 'joined', room: roomKey }));
      }
    } catch (error) {
      console.error('Erro no message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client desconectado');
    ws.rooms.forEach(room => {
      if (channels.has(room)) {
        channels.get(room).delete(ws);
        if (channels.get(room).size === 0) channels.delete(room);
      }
    });
  });
});

// Interval ping/pong
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);
server.on('close', () => clearInterval(interval));

// Handle Twitch messages
twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;
  const roomKey = `twitch-${channel.toLowerCase()}`;
  if (!channels.has(roomKey)) return;
  broadcastToRoom(roomKey, {
    user: tags['display-name'],
    message,
    badges: formatBadges(tags.badges),
    isAction: tags['message-type'] === 'action',
    userId: tags['user-id'],
    msgId: tags.id,
    emotes: tags.emotes ? Object.keys(tags.emotes).map(name => ({ name, positions: tags.emotes[name] })) : [],
    platform: 'twitch'
  });
});

// Handle Twitch deletes
twitchClient.on('deletemessage', (channel, msgid) => {
  const roomKey = `twitch-${channel.toLowerCase()}`;
  if (!channels.has(roomKey)) return;
  broadcastToRoom(roomKey, { type: 'delete-message', msgId: msgid });
});
twitchClient.on('clearchat', (channel, tags) => {
  const roomKey = `twitch-${channel.toLowerCase()}`;
  if (!channels.has(roomKey)) return;
  if (tags['target-user-id']) {
    broadcastToRoom(roomKey, { type: 'delete-messages', userId: tags['target-user-id'] });
  } else {
    // Clear all if no user
    broadcastToRoom(roomKey, { type: 'clear-chat' }); // JS pode limpar tudo se receber isso
  }
});

// Handle Kick messages
function handleKickMessage(event, channel) {
  try {
    const jsonData = JSON.parse(event.data);
    const jsonDataSub = JSON.parse(jsonData.data);
    const roomKey = `kick-${channel.toLowerCase()}`;
    if (!channels.has(roomKey)) return;
    if (jsonData.event === "App\\Events\\MessageDeletedEvent") {
      broadcastToRoom(roomKey, { type: 'delete-message', msgId: jsonDataSub.message.id });
      return;
    }
    // Mensagem normal - envie raw content para processar no client
    broadcastToRoom(roomKey, {
      user: jsonDataSub.sender.username,
      message: jsonDataSub.content, // Raw para client processar emotes
      badges: '', // Adicione se Kick tiver badges
      isAction: false,
      userId: jsonDataSub.sender.id,
      msgId: jsonDataSub.id,
      platform: 'kick'
    });
  } catch (e) {
    console.error('Erro no Kick message:', e);
  }
}

// Função broadcast para room
function broadcastToRoom(roomKey, data) {
  if (!channels.has(roomKey)) return;
  channels.get(roomKey).forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Formata badges Twitch
function formatBadges(badges) {
  let badgeHtml = '';
  if (badges) {
    Object.entries(badges).forEach(([type, version]) => {
      const url = `https://static-cdn.jtvnw.net/badges/v1/${getBadgeId(type, version)}/3`; // Função para ID de badge
      badgeHtml += `<img alt="" src="${url}" class="twitchbadge"> `;
    });
  }
  return badgeHtml;
}

// Placeholder para badge IDs - Adapte com mapa real ou fetch
function getBadgeId(type, version) {
  const badgeMap = {
    broadcaster: '5527c58c-fb7d-422d-b5b9-4b40adfc714a',
    moderator: '3267646d-33f0-4b17-b3df-f923a41db1d0',
    // Adicione mais
  };
  return badgeMap[type] || 'default';
}

// Porta para local/Render
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server rodando na porta ${PORT}`));