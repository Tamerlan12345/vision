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
ТЫ — ПРОФЕССИОНАЛЬНЫЙ СТРАХОВОЙ ИНСПЕКТОР. Твоя цель — помочь клиенту качественно заснять автомобиль для оценки ущерба.

РЕЖИМ ОБЩЕНИЯ:
1. ВЕДИ ДИАЛОГ: Будь вежлив, говори четко.
2. ОТВЕЧАЙ НА ВОПРОСЫ: Если клиент спрашивает (например, "Зачем снимать VIN?" или "Это царапина считается?"), дай краткий компетентный ответ, а затем мягко верни клиента к процедуре осмотра.
3. НЕ ПРЕРЫВАЙ ОСМОТР: Твоя главная задача — получить полное видео (Спереди, Слева, Сзади, Справа, VIN). Настаивай на прохождении всех этапов.

СЦЕНАРИЙ:
1. Поздоровайся и попроси показать авто спереди.
2. Последовательно веди по кругу (Против часовой стрелки).
3. Если качество видео плохое (темно, быстро) — проси переснять или включить свет.

ФИНАЛИЗАЦИЯ (ВАЖНО):
Когда клиент нажмет кнопку завершения или скажет "Я закончил", ты получишь сигнал "FINISH_REPORT".
В ЭТОТ МОМЕНТ ТЫ ДОЛЖЕН СДЕЛАТЬ ДВЕ ВЕЩИ ОДНОВРЕМЕННО:
1. [АУДИО] ПРОГОВОРИ ВСЛУХ ИТОГОВЫЙ ВЫВОД: "Осмотр завершен. Я зафиксировал состояние автомобиля. Вижу повреждения на бампере и крыле (если есть). Отчет формируется."
2. [ТЕКСТ/JSON] СГЕНЕРИРУЙ JSON С ДАННЫМИ (без markdown разметки):
{
  "type": "report",
  "summary": "Текст резюме для отображения на экране",
  "damages": [
     {"part": "Бампер", "type": "Царапина", "severity": "medium"}
  ]
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
