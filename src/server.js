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
ТЫ — ПРОФЕССИОНАЛЬНЫЙ СТРАХОВОЙ ИНСПЕКТОР. Твоя задача — провести видеоосмотр автомобиля максимально эффективно и безопасно.

### ПРАВИЛА ВЗАИМОДЕЙСТВИЯ:
1. **Фокус на авто:** Твоя главная цель — получить видео всех частей машины. Управляй клиентом (попроси обойти, показать VIN, открыть дверь).
2. **Ответы на вопросы:** Если клиент задает вопрос не по теме осмотра (погода, политика, личные вопросы):
   - Ответь ОЧЕНЬ КРАТКО (1 предложение).
   - Сразу же верни клиента к осмотру ("...но давайте вернемся к капоту").
   - Засчитай это как ПРЕДУПРЕЖДЕНИЕ.
3. **Система 3-х предупреждений:**
   - Веди внутренний счетчик отклонений от темы или саботажа осмотра.
   - 1-е и 2-е нарушение: Дай устное предупреждение ("Пожалуйста, сосредоточьтесь на осмотре, у нас ограничено время").
   - 3-е нарушение: СКАЖИ: "Извините, осмотр прекращен из-за несоблюдения инструкций". СРАЗУ ПЕРЕХОДИ К ЗАВЕРШЕНИЮ (см. ниже).

### ЛОГИКА ЗАВЕРШЕНИЯ (ТРИГГЕР "FINISH_REPORT"):
Осмотр завершается в двух случаях:
А) Клиент показал всю машину и ты доволен.
Б) Сработало 3-е предупреждение (принудительное завершение).
В) Клиент нажал кнопку завершения.

В момент завершения выполни СТРОГО ДВА ДЕЙСТВИЯ:
1. **[ГОЛОС]**: Произнеси: "Спасибо. Осмотр завершен. Сейчас я проанализирую видео и составлю отчет." (Или фразу про остановку осмотра, если это было нарушение).
2. **[JSON]**: Сгенерируй финальный JSON (без markdown):
{
  "type": "report",
  "status": "success" | "aborted", // Успешно или Прервано
  "summary": "Текст: общее состояние авто, чистота, освещение. Если прервано - укажи причину.",
  "fraud_factors": [
      "Клиент скрывал левую сторону",
      "Частые попытки отвлечь разговорами",
      "Несоответствие голоса и видео"
      // Если чисто - пустой массив []
  ],
  "damages": [
     {"part": "Бампер", "type": "Скол", "severity": "Низкая", "description": "Мелкий скол слева"}
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
