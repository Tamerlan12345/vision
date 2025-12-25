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

        // 1. ОТПРАВКА КОНФИГУРАЦИИ (Фикс молчания)
        const setupMsg = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                generation_config: {
                    response_modalities: ["AUDIO"],
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Kore" } } // Голос: Kore, Puck, Fenrir
                    }
                },
                system_instruction: {
                    parts: [{
                        text: `
ТЫ — СТРОГИЙ, НО ВЕЖЛИВЫЙ СТРАХОВОЙ ИНСПЕКТОР.
Твоя задача — провести удаленный осмотр автомобиля через камеру клиента в реальном времени.

СЦЕНАРИЙ РАБОТЫ:
1. ПРИВЕТСТВИЕ: Сразу после подключения скажи: "Здравствуйте. Я готов к осмотру. Пожалуйста, покажите автомобиль спереди так, чтобы было видно номерной знак".
2. ВЕДЕНИЕ:
   - Если клиент молчит > 5 секунд: "Я вас не слышу. Вы здесь?"
   - Если видео темное: "Включите фонарик, освещение недостаточное".
   - Если камера трясется: "Зафиксируйте телефон, изображение размыто".
   - Этапы: Перед -> Левый бок -> Задняя часть -> Правый бок -> VIN-код на стекле или стойке.
3. FRAUD-КОНТРОЛЬ (АНТИФРОД):
   - Если ты видишь пиксельную сетку, муар или рамки монитора (клиент снимает видео с другого экрана) — СРОЧНО СКАЖИ: "Вы снимаете экран монитора. Это недопустимо. Покажите реальный автомобиль или осмотр будет прерван".
   - Если голос не совпадает с движением губ (рассинхрон) или звучит неестественно — отметь это для отчета.

ФИНАЛИЗАЦИЯ (КОГДА ПОЛУЧЕН ТЕКСТОВЫЙ ЗАПРОС "FINISH_REPORT"):
Перестань говорить голосом. Сгенерируй ТОЛЬКО JSON структуру:
{
  "status": "success" | "rejected",
  "fraud_detected": true | false,
  "fraud_reasons": ["монитор", "монтаж"],
  "damages": [
     {"part": "Бампер передний", "type": "Царапина", "severity": "low"},
     {"part": "Лобовое стекло", "type": "Скол", "severity": "medium"}
  ],
  "summary": "Краткое резюме осмотра на русском."
}
                        `
                    }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));

        // 2. ОТПРАВКА ПЕРВОГО ТРИГГЕРА (Чтобы ИИ заговорил первым)
        const wakeUpMsg = {
             client_content: {
                 turns: [{ parts: [{ text: "Начинаем осмотр." }], role: "user" }],
                 turn_complete: true
             }
        };
        geminiWs.send(JSON.stringify(wakeUpMsg));
    });

    geminiWs.on('message', (data) => {
        try {
            const strData = data.toString();
            const json = JSON.parse(strData);
            // Если пришел текстовый контент (JSON отчета)
            if (json.serverContent?.modelTurn?.parts?.[0]?.text) {
                const text = json.serverContent.modelTurn.parts[0].text;
                // Try to parse text as JSON if possible, otherwise send as text report or logic
                // The client expects { type: 'report', text: ... } or just raw JSON
                // Since the model instruction says "Generate ONLY JSON structure", the text SHOULD be JSON.
                wsClient.send(JSON.stringify({ type: 'report', text: text }));
            } else {
                // Аудио данные или метаданные (например turn_complete)
                // We just forward them. The client handles audio blobs or ignores metadata json.
                // However, 'ws' library sends as string if it's text frame, Buffer if binary.
                // Gemini sends JSON as text frames (metadata) and Audio as binary (maybe? No, Gemini sends JSON with base64 audio usually in Bidi?)
                // WAIT. Gemini Bidi API sends everything as JSON messages except maybe if configured otherwise?
                // Documentation says: "The response is a stream of BidiGenerateContentResponse messages."
                // Protocol buffers over WebSocket usually. But here we are using the JSON endpoint `wss://.../v1alpha/...`?
                // Actually the URL `.../ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent` uses a custom protocol over WS.
                // It sends JSON text frames for control/text and BINARY frames for audio if using "AUDIO" modality?

                // Let's look at the "catch" block in the provided snippet.
                // It suggests `JSON.parse` fails on binary data.

                // If it's binary, it's likely PCM.
                // If it's text, it's a JSON response.

                // Gemini Bidi often wraps audio in JSON `serverContent: { modelTurn: { parts: [ { inlineData: ... } ] } }`.
                // BUT the snippet implies binary data flow: "catch (e) { wsClient.send(data); }"
                // This implies `data` is not JSON string.

                wsClient.send(data);
            }
        } catch (e) {
            // Бинарные данные (PCM аудио)
            wsClient.send(data);
        }
    });

    wsClient.on('message', (data) => {
        // Проброс данных от клиента в Gemini
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(data);
        }
    });

    wsClient.on('close', () => {
        console.log("Client disconnected. Closing Gemini bridge.");
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    geminiWs.on('close', () => {
        console.log("Gemini connection closed.");
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.close();
        }
    });

    geminiWs.on('error', (err) => {
        console.error("Gemini WebSocket Error:", err);
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.close();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
