import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Client, Databases, Query } from 'appwrite';
import express from 'express';
import bodyParser from 'body-parser';

let bot = null;

// Nuevo: almacena todos los viajes disponibles
const pendingRides = {};  // rideId -> ride

// Nuevo: almacena qué viajes fueron enviados a cada conductor
const notifiedRidesByDriver = {};  // chat_id -> [rideId1, rideId2, ...]


// Inicia el cliente de Appwrite
const initializeAppwriteClient = () => {
  const client = new Client();
  client.setEndpoint(process.env.APPWRITE_ENDPOINT);
  client.setProject(process.env.APPWRITE_PROJECT_ID);
  if (typeof client.setKey === 'function') {
    client.setKey(process.env.APPWRITE_API_KEY);
  } else if (client.headers) {
    client.headers['X-Appwrite-Key'] = process.env.APPWRITE_API_KEY;
  }
  return client;
};

// Obtiene el teléfono de un usuario por su ID
const getPhoneByUserId = async (databases, userId) => {
  try {
    const response = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.EXPO_PUBLIC_APPWRITE_USER_PHONES_COLLECTION_ID,
      [Query.equal('user_id', userId)]
    );
    return response.documents[0]?.phone || null;
  } catch (err) {
    console.error('Error fetching phone number:', err);
    return null;
  }
};

// Inicia el bot de Telegram
const initializeTelegramBot = () => {
  if (bot) return bot;
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('✅ Telegram bot initialized successfully');
  return bot;
};

const formatCoordsLink = (label, coords) => {
  let lat, lng;

  if (typeof coords === 'string') {
    // Elimina corchetes y espacios extra
    const clean = coords.replace(/[\[\]\s]/g, '');
    const parts = clean.split(',').map(Number);
    if (parts.length === 2 && parts.every(n => !isNaN(n))) {
      [lat, lng] = parts;
    }
  } else if (Array.isArray(coords) && coords.length === 2) {
    const parts = coords.map(n => Number(n));
    if (parts.every(n => !isNaN(n))) {
      [lat, lng] = parts;
    }
  }

  if (lat == null || lng == null) {
    return `${text}: Coordenadas inválidas`;
  }

  return `[${label}](https://www.google.com/maps/place/${lat},${lng})`;
};




// Formatea las paradas para el mensaje
const formatStopsFullFromStrings = (stops = [], stopsCoords = []) => {
  if (!Array.isArray(stops) || stops.length === 0) return 'Ninguna';

  return stops.map((stop, index) => {
    const [address, note] = stop.split('||').map(s => s.trim());
    const coord = stopsCoords?.[index];
    let lat, lng;

    if (typeof coord === 'string') {
      const clean = coord.replace(/[\[\]\s]/g, '');
      const parts = clean.split(',').map(Number);
      if (parts.length === 2 && !parts.some(isNaN)) {
        [lat, lng] = parts;
      }
    } else if (Array.isArray(coord) && coord.length === 2) {
      const parts = coord.map(n => Number(n));
      if (parts.every(n => !isNaN(n))) {
        [lat, lng] = parts;
      }
    }

    const addressLink = (lat != null && lng != null)
      ? `[${address}](https://www.google.com/maps/place/${lat},${lng})`
      : address;

    return `${index + 1}. 📍 Dirección: ${addressLink}\n   ✏️ Indicaciones: ${note || 'Ninguna'}`;
  }).join('\n');
};




// Formatea el mensaje del viaje
const formatRideMessage = (ride) => {
  const price = parseFloat(ride.price);
  const precioReal = price - 5.28;
  const ganancia = precioReal * 0.7;
  const phoneLink = ride.phone ? `https://wa.me/${ride.phone.replace(/[^\d]/g, '')}` : null;
  const adminLink = 'https://wa.me/527223711236';
  console.log('Origen:', ride.originCoords, 'Tipo:', typeof ride.originCoords);
  console.log('Destino:', ride.destinationCoords);


  return `🆕 *Nuevo viaje disponible*:

🧍 Usuario ID: ${ride.user_id}
📞 Teléfono: ${ride.phone || 'No disponible'}
🛣️ De: ${formatCoordsLink(ride.startPoint, ride.originCoords)}
🏁 A: ${formatCoordsLink(ride.endPoint, ride.destinationCoords)}
📦 Peso: ${ride.weight}
🚚 Tipo: ${ride.type}
💬 Indicaciones punto final: ${ride.indications || 'Ninguna'}
📏 Distancia: ${ride.distance} km
💵 Ganancia: $${ganancia.toFixed(2)}

🛑 Paradas:
${formatStopsFullFromStrings(ride.stops, ride.stopsCoords)}


${phoneLink ? `[📨 Enviar verificación de entrega](${phoneLink})` : ''}
[📦 Comprobación de entrega para pago](${adminLink})

Al finalizar el viaje, responde con /terminar.`;
};


// Notifica a los conductores sobre el viaje
const notifyDrivers = async (ride, bot, databases) => {
  if (!ride?.$id) return;

  const phone = await getPhoneByUserId(databases, ride.user_id);
  ride.phone = phone;

  // Guardar el viaje en el mapa de viajes pendientes
  pendingRides[ride.$id] = ride;

  const drivers = (await databases.listDocuments(
    process.env.APPWRITE_DATABASE_ID,
    process.env.APPWRITE_DRIVERS_COLLECTION_ID
  )).documents;

  const message = formatRideMessage(ride);

  for (const driver of drivers) {
    const chatId = driver.chat_id;

    // Registrar que a este conductor se le notificó este viaje
    if (!notifiedRidesByDriver[chatId]) {
      notifiedRidesByDriver[chatId] = [];
    }
    notifiedRidesByDriver[chatId].push(ride.$id);

    // Enviar el mensaje con el comando específico
    await bot.sendMessage(chatId, message + `\n\n👉 Para aceptar este viaje, responde con:\n/aceptar ${ride.$id}`, {
      parse_mode: 'Markdown'
    });
  }
};


// Configura los manejadores del bot
const setupBotHandlers = (bot, databases) => {
  const driverStates = {};

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🚗 ¡Bienvenido conductor! Por favor, envía tu nombre completo:');
    driverStates[chatId] = { step: 'asking_name' };
  });

  bot.onText(/\/aceptar (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const rideId = match[1];

    console.log(`🛎️ Comando /aceptar recibido de ${chatId} para ride ${rideId}`); // <- Agrega esto

  
    const ride = pendingRides[rideId];
    if (!ride) {
      return bot.sendMessage(chatId, '❌ Este viaje ya no está disponible o ya fue tomado.');
    }
  
    // Verifica que este viaje fue enviado a este conductor
    const notified = notifiedRidesByDriver[chatId];
    if (!notified || !notified.includes(rideId)) {
      return bot.sendMessage(chatId, '❌ No tienes este viaje en tu lista de notificaciones.');
    }
  
    try {
      const driverDoc = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_DRIVERS_COLLECTION_ID,
        [Query.equal('chat_id', chatId.toString())]
      );
      const driver = driverDoc.documents[0];
      if (!driver) {
        return bot.sendMessage(chatId, '❌ No estás registrado.');
      }
  
      await databases.updateDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.EXPO_PUBLIC_APPWRITE_RIDES_COLLECTION_ID,
        rideId,
        {
          driverName: driver.name,
          plate: driver.plate,
          driverChatId: chatId.toString(),
          status: 'en-curso',
        }
      );
  
      bot.sendMessage(chatId, `✅ ¡Has aceptado el viaje ${rideId}! Gracias, ${driver.name}.`);
  
      const allDrivers = (await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_DRIVERS_COLLECTION_ID
      )).documents;
  
      for (const other of allDrivers) {
        if (other.chat_id !== chatId.toString()) {
          bot.sendMessage(other.chat_id, '❌ El viaje ya fue tomado.');
        }
      }
  
      // Elimina el viaje de la lista de pendientes y notificados
      delete pendingRides[rideId];
      for (const driverId in notifiedRidesByDriver) {
        notifiedRidesByDriver[driverId] = notifiedRidesByDriver[driverId].filter(id => id !== rideId);
      }
  
    } catch (err) {
      console.error('❌ Error al aceptar:', err);
      bot.sendMessage(chatId, '❌ Error al aceptar el viaje. Intenta otra vez.');
    }
  });
  

  bot.onText(/\/terminar/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const rides = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.EXPO_PUBLIC_APPWRITE_RIDES_COLLECTION_ID,
        [Query.equal('status', 'en-curso'), Query.equal('driverChatId', chatId.toString())]
      );
      const ride = rides.documents[0];

      if (!ride) return bot.sendMessage(chatId, '❌ No tienes viajes en curso.');

      await databases.updateDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.EXPO_PUBLIC_APPWRITE_RIDES_COLLECTION_ID,
        ride.$id,
        { status: 'completado' }
      );

      bot.sendMessage(chatId, '✅ Has marcado el viaje como completado. ¡Gracias!');
    } catch (err) {
      console.error('❌ Error al terminar:', err);
      bot.sendMessage(chatId, '❌ Error al completar el viaje.');
    }
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || !driverStates[chatId]) return;
    const state = driverStates[chatId];

    try {
      if (state.step === 'asking_name') {
        if (text.length < 2) return bot.sendMessage(chatId, '❌ Nombre muy corto');
        state.name = text;
        state.step = 'asking_plate';
        bot.sendMessage(chatId, '✅ Ahora escribe la placa de tu vehículo:');
      } else if (state.step === 'asking_plate') {
        if (text.length < 4) return bot.sendMessage(chatId, '❌ Placa inválida');
        state.plate = text;
        await databases.createDocument(
          process.env.APPWRITE_DATABASE_ID,
          process.env.APPWRITE_DRIVERS_COLLECTION_ID,
          'unique()',
          {
            name: state.name,
            plate: state.plate,
            chat_id: chatId.toString(),
            registered_at: new Date().toISOString(),
          }
        );
        bot.sendMessage(chatId, `🎉 Registro completo. Gracias, ${state.name}.`);
        delete driverStates[chatId];
      }
    } catch (error) {
      console.error('Error:', error);
      bot.sendMessage(chatId, '❌ Error técnico. Intenta de nuevo.');
    }
  });
};

// Crea y configura el servidor Express
const createServer = () => {
  const app = express();
  const PORT = process.env.PORT || 10000;
  
  app.use(bodyParser.json());

  app.get('/', (req, res) => {
    res.send('🚀 Bot is running!');
  });

  // Webhook handler (opcional si se quiere usar un endpoint)
  app.post('/webhook', async (req, res) => {
    try {
      const { $id } = req.body;
  
      if (!$id) {
        return res.status(400).json({ success: false, error: 'Falta el ID del viaje' });
      }
  
      const client = initializeAppwriteClient();
      const databases = new Databases(client);
      const ride = await databases.getDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.EXPO_PUBLIC_APPWRITE_RIDES_COLLECTION_ID,
        $id
      );
  
      await notifyDrivers(ride, bot, databases);
      return res.json({ success: true });
  
    } catch (err) {
      console.error(err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });
  

  app.listen(PORT, () => {
    console.log(`🌐 Servidor escuchando en puerto ${PORT}`);
  });
};

// Inicializa la aplicación
async function main() {
  try {
    const client = initializeAppwriteClient();
    const databases = new Databases(client);
    bot = initializeTelegramBot();
    setupBotHandlers(bot, databases);
    createServer();
    console.log('🚀 Bot y servidor iniciados');
  } catch (error) {
    console.error('❌ Error al iniciar:', error.message);
    process.exit(1);
  }
}

main();
