require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const analyzeController = require('./controllers/analyze');
const analyzeVideoController = require('./controllers/analyzeVideo');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.post('/api/analyze', analyzeController.handle);
app.post('/api/analyze-video', analyzeVideoController.handle);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket Server for Live Inspection
const wss = new WebSocket.Server({ server, path: '/ws/live-inspection' });

wss.on('connection', (wsClient) => {
    console.log("Client connected. Establishing bridge to Gemini...");

    const geminiWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`);

    geminiWs.on('open', () => {
        console.log("Gemini Connected. Sending Setup...");

        // 1. ОТПРАВКА КОНФИГУРАЦИИ
        const setupMsg = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                generation_config: {
                    response_modalities: ["AUDIO"], // Основной канал - аудио
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Kore" } }
                    }
                },
                system_instruction: {
                    parts: [{
                        text: `
ТЫ — ПРОФЕССИОНАЛЬНЫЙ СТРАХОВОЙ ИНСПЕКТОР. Твоя задача — провести видеоосмотр автомобиля.

### ТВОИ ДЕЙСТВИЯ:
1. Попроси клиента показать автомобиль с разных сторон (спереди, сзади, слева, справа).
2. Если видишь повреждение, попроси показать ближе, но не затягивай.

### ЗАВЕРШЕНИЕ ОСМОТРА (ТРИГГЕР "FINISH_REPORT"):
Когда ты получишь сообщение "FINISH_REPORT" от системы (это значит пользователь нажал кнопку завершения):

1. **[ГОЛОС] СКАЖИ СТРОГО ЭТУ ФРАЗУ:**
   "Спасибо, осмотр завершился, анализ будет предоставлен ниже."

2. **[JSON] СГЕНЕРИРУЙ ФИНАЛЬНЫЙ ОТЧЕТ (без markdown):**
{
  "type": "report",
  "status": "success",
  "summary": "Краткое резюме о состоянии авто (чистота, освещение, полнота осмотра).",
  "fraud_factors": [
      "Пример: Не показана левая сторона",
      "Пример: Подозрительные скачки камеры"
      // Если всё чисто, оставь массив пустым []
  ],
  "damages": [
     {"part": "Передний бампер", "type": "Царапина", "description": "Глубокая царапина слева внизу"}
     // Перечисли все замеченные повреждения
  ]
}
`
                    }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));

        // 2. ОТПРАВКА ПРИВЕТСТВИЯ
        const wakeUpMsg = {
             client_content: {
                 turns: [{ parts: [{ text: "Здравствуйте, я готов начать осмотр." }], role: "user" }],
                 turn_complete: true
             }
        };
        geminiWs.send(JSON.stringify(wakeUpMsg));
    });

    geminiWs.on('message', (data) => {
        try {
            const strData = data.toString();
            const json = JSON.parse(strData);

            if (json.serverContent?.modelTurn?.parts?.[0]?.text) {
                const text = json.serverContent.modelTurn.parts[0].text;
                // Пробрасываем текст отчета клиенту
                wsClient.send(JSON.stringify({ type: 'report', text: text }));
            }
            else if (json.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                 // Пробрасываем аудио клиенту
                 wsClient.send(data);
            }
        } catch (e) {
            wsClient.send(data);
        }
    });

    wsClient.on('message', (data) => {
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(data);
        }
    });

    wsClient.on('close', () => {
        console.log("Client disconnected.");
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    });

    geminiWs.on('close', () => {
        console.log("Gemini connection closed.");
        if (wsClient.readyState === WebSocket.OPEN) wsClient.close();
    });

    geminiWs.on('error', (err) => console.error("Gemini Error:", err));
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
