import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Client, Databases, Query } from 'appwrite';
import express from 'express';
import bodyParser from 'body-parser';

let bot = null;
let pendingRide = null;
let rideTimeout = null;
let lastNotifiedRideId = null;

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
  if (!Array.isArray(coords) || coords.length !== 2) return `${label}: Coordenadas inválidas`;
  const [lat, lng] = coords;
  return `[${label}](https://www.google.com/maps/search/?api=1&query=${lat},${lng})`;
};



// Formatea las paradas para el mensaje
const formatStopsCoords = (stopsCoords = []) => {
  if (!Array.isArray(stopsCoords) || stopsCoords.length === 0) return 'Ninguna';
  
  return stopsCoords
    .map((coord, index) => {
      if (!Array.isArray(coord) || coord.length !== 2) return null;
      const [lat, lng] = coord;
      const link = `[Parada ${index + 1}](https://www.google.com/maps/search/?api=1&query=${lat},${lng})`;
      return `${index + 1}. 📍 ${link}`;
    })
    .filter(Boolean)
    .join('\n');
};



// Formatea el mensaje del viaje
const formatRideMessage = (ride) => {
  const price = parseFloat(ride.price);
  const precioReal = price - 5.28;
  const ganancia = precioReal * 0.7;
  const phoneLink = ride.phone ? `https://wa.me/${ride.phone.replace(/[^\d]/g, '')}` : null;
  const adminLink = 'https://wa.me/527223711236';

  return `🆕 *Nuevo viaje disponible*:

🧍 Usuario ID: ${ride.user_id}
📞 Teléfono: ${ride.phone || 'No disponible'}
🛣️ Origen: ${formatCoordsLink('Origen', ride.originCoords)}
🏁 Destino: ${formatCoordsLink('Destino', ride.destinationCoords)}
📦 Peso: ${ride.weight}
🚚 Tipo: ${ride.type}
💬 Indicaciones punto final: ${ride.indications || 'Ninguna'}
📏 Distancia: ${ride.distance} km
💵 Ganancia: $${ganancia.toFixed(2)}

🛑 Paradas:
${formatStopsCoords(ride.stopsCoords)}

${phoneLink ? `[📨 Enviar verificación de entrega](${phoneLink})` : ''}
[📦 Comprobación de entrega para pago](${adminLink})

Responde con /aceptar para tomar este viaje.
Al finalizar el viaje, responde con /terminar.`;
};


// Notifica a los conductores sobre el viaje
const notifyDrivers = async (ride, bot, databases) => {
  if (ride.$id === lastNotifiedRideId) return;
  const phone = await getPhoneByUserId(databases, ride.user_id);
  ride.phone = phone;
  lastNotifiedRideId = ride.$id;
  pendingRide = ride;

  const drivers = (await databases.listDocuments(
    process.env.APPWRITE_DATABASE_ID,
    process.env.APPWRITE_DRIVERS_COLLECTION_ID
  )).documents;

  const message = formatRideMessage(ride);

  for (const driver of drivers) {
    await bot.sendMessage(driver.chat_id, message, { parse_mode: 'Markdown' });
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

  bot.onText(/\/aceptar/, async (msg) => {
    const chatId = msg.chat.id;
    if (!pendingRide) return bot.sendMessage(chatId, '❌ No hay ningún viaje disponible.');

    try {
      const driverDoc = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_DRIVERS_COLLECTION_ID,
        [Query.equal('chat_id', chatId.toString())]
      );
      const driver = driverDoc.documents[0];
      if (!driver) return bot.sendMessage(chatId, '❌ No estás registrado.');

      await databases.updateDocument(
        process.env.APPWRITE_DATABASE_ID,
        process.env.EXPO_PUBLIC_APPWRITE_RIDES_COLLECTION_ID,
        pendingRide.$id,
        {
          driverName: driver.name,
          plate: driver.plate,
          driverChatId: chatId.toString(),
          status: 'en-curso',
        }
      );

      bot.sendMessage(chatId, `✅ ¡Has aceptado el viaje! Gracias, ${driver.name}.`);

      const others = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_DRIVERS_COLLECTION_ID
      );
      for (const other of others.documents) {
        if (other.chat_id !== chatId.toString()) {
          bot.sendMessage(other.chat_id, '❌ El viaje ya fue tomado.');
        }
      }

      clearTimeout(rideTimeout);
      pendingRide = null;
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
      const ride = req.body;
      if (!ride || !ride.startPoint || !ride.endPoint || !ride.rideDate) {
        return res.status(400).json({ success: false, error: 'Datos del viaje incompletos' });
      }

      const client = initializeAppwriteClient();
      const databases = new Databases(client);
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
