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
                    response_modalities: ["AUDIO", "TEXT"], // ВАЖНО: Разрешаем оба канала
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Kore" } }
                    }
                },
                system_instruction: {
                    parts: [{
                        text: `
ТЫ — ПРОФЕССИОНАЛЬНЫЙ СТРАХОВОЙ ИНСПЕКТОР.

ЗАДАЧА:
Провести видеоосмотр автомобиля. Управляй человеком, проси показать детали (VIN, пробег, повреждения).

ПРАВИЛА:
1. Будь краток и вежлив.
2. Если видишь повреждение, попроси показать ближе.
3. В конце скажи: "Спасибо, осмотр завершен".

ВАЖНО - ФОРМАТ ЗАВЕРШЕНИЯ (ТРИГГЕР "FINISH_REPORT"):
Когда осмотр окончен или получена команда "FINISH_REPORT", ты должен сделать ДВА действия в одном ответе:

ШАГ 1 (ГОЛОС):
Произнеси вслух фразу: "Осмотр завершен. Составляю отчет."

ШАГ 2 (ТЕКСТ/JSON):
Сгенерируй JSON с результатами.
КРИТИЧЕСКИ ВАЖНО: НИКОГДА НЕ ЧИТАЙ JSON ВСЛУХ! JSON ДОЛЖЕН БЫТЬ ТОЛЬКО В ТЕКСТОВОМ ВИДЕ ДЛЯ СИСТЕМЫ.

Структура JSON:
{
  "type": "report",
  "status": "success",
  "summary": "Краткое резюме на русском",
  "damages": [
     {"part": "Бампер", "type": "Царапина", "description": "Слева"}
  ]
}

ВАЖНО - ПРИ ЗАВЕРШЕНИИ:
1. КАНАЛ АУДИО: Скажи "Осмотр завершен".
2. КАНАЛ ТЕКСТА: Отправь только JSON. НЕ ЧИТАЙ ЕГО ВСЛУХ.
`
                    }]
                }
            }
        };
        geminiWs.send(JSON.stringify(setupMsg));

        // 2. ОТПРАВКА ПРИВЕТСТВИЯ
        const wakeUpMsg = {
             client_content: {
                 turns: [{ parts: [{ text: "Здравствуйте, я готов к осмотру." }], role: "user" }],
                 turn_complete: true
             }
        };
        geminiWs.send(JSON.stringify(wakeUpMsg));
    });

    geminiWs.on('message', (data) => {
        try {
            const strData = data.toString();
            const json = JSON.parse(strData);

            // Проверяем, есть ли текстовый ответ (это наш JSON отчета)
            if (json.serverContent?.modelTurn?.parts) {
                json.serverContent.modelTurn.parts.forEach(part => {
                    if (part.text) {
                        // Отправляем на фронтенд сигнал для закрытия окна и показа таблицы
                        wsClient.send(JSON.stringify({ type: 'report', text: part.text }));
                    }
                });
            }
            // Пересылаем аудио данные клиенту как обычно
            wsClient.send(data);
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
