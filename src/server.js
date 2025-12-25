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
ТЫ — ВЕЖЛИВЫЙ СТРАХОВОЙ ИНСПЕКТОР.
Твоя задача — провести удаленный осмотр автомобиля через камеру клиента в реальном времени.

СЦЕНАРИЙ РАБОТЫ:
1. ПРИВЕТСТВИЕ: "Здравствуйте. Я готов к осмотру. Пожалуйста, покажите автомобиль спереди."
2. ВЕДЕНИЕ:
   - Если клиент молчит > 5 секунд: "Вы здесь?"
   - Если видео темное: "Включите фонарик."
   - Этапы: Перед -> Левый бок -> Задняя часть -> Правый бок -> VIN.
3. FRAUD-КОНТРОЛЬ (ОСЛАБЛЕННЫЙ):
   - Если похоже, что снимают монитор, мягко уточни: "Пожалуйста, убедитесь, что вы снимаете реальный автомобиль, а не экран." (Не прерывай осмотр агрессивно).

ФИНАЛИЗАЦИЯ (ПО КОМАНДЕ "FINISH_REPORT"):
1. ПЕРЕСТАНЬ ГОВОРИТЬ ГОЛОСОМ. Твой аудио-ответ должен быть тишиной или пустым.
2. СГЕНЕРИРУЙ ТЕКСТОВЫЙ ОТЧЕТ В ФОРМАТЕ JSON.
Структура JSON:
{
  "status": "success",
  "fraud_detected": false,
  "damages": [
     {"part": "Название детали", "type": "Тип повреждения", "severity": "low/medium/high"}
  ],
  "summary": "Краткое резюме осмотра на русском."
}
                        `
                    }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));

        // 2. ОТПРАВКА ПЕРВОГО ТРИГГЕРА
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

            // Ловим текстовый контент (JSON отчета)
            if (json.serverContent?.modelTurn?.parts?.[0]?.text) {
                const text = json.serverContent.modelTurn.parts[0].text;
                wsClient.send(JSON.stringify({ type: 'report', text: text }));
            }
            // Ловим Аудио (если есть)
            else if (json.serverContent?.modelTurn?.parts?.[0]?.inlineData) {
                 wsClient.send(data);
            }
            // Прочие метаданные просто игнорируем или пробрасываем, если нужно
        } catch (e) {
            // Бинарные данные (PCM аудио от Gemini иногда приходят так) или ошибки парсинга
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
