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

    if (!process.env.GEMINI_API_KEY) {
        console.error("Error: GEMINI_API_KEY is missing.");
        wsClient.send(JSON.stringify({ type: "error", message: "Server API Key missing" }));
        wsClient.close();
        return;
    }

    const geminiWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`);

    geminiWs.on('open', () => {
        console.log("Gemini Connected. Sending Setup...");

        // 1. ОТПРАВКА КОНФИГУРАЦИИ
        const setupMsg = {
            setup: {
                model: "models/gemini-2.0-flash-exp",
                generation_config: {
                    response_modalities: ["AUDIO"], // STRICTLY AUDIO
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Kore" } }
                    }
                },
                tools: [
                    {
                        function_declarations: [
                            {
                                name: "submit_report",
                                description: "Submits the final inspection report.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        summary: { type: "STRING", description: "Final summary of the inspection." },
                                        status: { type: "STRING", enum: ["success", "aborted"], description: "Status of the inspection." },
                                        damages: {
                                            type: "ARRAY",
                                            items: {
                                                type: "OBJECT",
                                                properties: {
                                                    part: { type: "STRING", description: "Car part name." },
                                                    type: { type: "STRING", description: "Type of damage." },
                                                    description: { type: "STRING", description: "Description of damage." }
                                                },
                                                required: ["part", "type"]
                                            }
                                        },
                                        fraud_factors: {
                                            type: "ARRAY",
                                            items: { type: "STRING" },
                                            description: "List of suspicious factors."
                                        }
                                    },
                                    required: ["summary", "status", "damages"]
                                }
                            }
                        ]
                    }
                ],
                system_instruction: {
                    parts: [{
                        text: `
Роль: Страховой инспектор.
Язык: Русский.

Сценарий:
1. Приветствие.
2. Просьба показать VIN.
3. Осмотр автомобиля по кругу.
4. Детализация повреждений (если есть).
5. Завершение.

Триггер завершения:
Когда осмотр завершен или получена команда "FINISH_REPORT":
1. Скажи голосом финальную фразу (например, "Осмотр закончен, формирую отчет").
2. НЕ ПИШИ ТЕКСТ.
3. ВЫЗОВИ ФУНКЦИЮ submit_report с параметрами отчета.
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

            // Обработка functionCall
            if (json.serverContent?.modelTurn?.parts) {
                for (const part of json.serverContent.modelTurn.parts) {
                    if (part.functionCall) {
                        const { name, args } = part.functionCall;
                        if (name === 'submit_report') {
                            console.log("Gemini called submit_report tool", args);
                            // Формируем сообщение для клиента
                            wsClient.send(JSON.stringify({ type: 'report', text: JSON.stringify(args) }));
                        }
                    }
                }
            }

            // Транслируем всё (включая аудио) клиенту
            wsClient.send(data);
        } catch (e) {
            console.error("Error processing Gemini message:", e);
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

    geminiWs.on('close', (code, reason) => {
        console.log(`Gemini connection closed. Code: ${code}, Reason: ${reason}`);
        if (wsClient.readyState === WebSocket.OPEN) {
             if (code !== 1000) {
                 wsClient.send(JSON.stringify({ type: "error", message: "Gemini connection closed unexpectedly" }));
             }
             wsClient.close();
        }
    });

    geminiWs.on('error', (err) => {
        console.error("Gemini Error:", err);
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: "error", message: "Error connecting to AI service" }));
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
