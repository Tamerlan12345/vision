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
app.use(express.json({ limit: '500mb' })); // Increased limit for video uploads
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.post('/api/analyze', analyzeController.handle);
app.post('/api/analyze-video', analyzeVideoController.handle);

// Create HTTP server
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const MODEL = "models/gemini-2.0-flash-exp";
    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

    let geminiWs = null;

    try {
        geminiWs = new WebSocket(geminiUrl);
    } catch (error) {
        console.error('Error creating Gemini WebSocket:', error);
        ws.close();
        return;
    }

    geminiWs.on('open', () => {
        console.log('Connected to Gemini Live API');

        // Initial Setup Message
        const initialSetup = {
            setup: {
                model: MODEL,
                generation_config: {
                    response_modalities: ["AUDIO"],
                    speech_config: {
                        voice_config: { prebuilt_voice_config: { voice_name: "Kore" } }
                    }
                },
                system_instruction: {
                    parts: [{
                        text: `
Ты — ИИ-инспектор для проверки автотранспорта. Твоя задача — руководить клиентом и искать мошенничество.
1. Говори на русском языке. Фразы короткие и четкие.
2. Сценарий: Попроси показать авто спереди, сзади, VIN и салон.
3. Fraud-контроль:
   - Если темно: "Включите свет".
   - Если камера трясется: "Держите камеру ровно".
   - Если видишь, что снимают экран монитора (пиксели, муар, рамки): "Я вижу, что вы снимаете экран. Покажите реальную машину".
4. ФИНАЛ:
   Когда я нажму кнопку "Стоп" или ты решишь закончить, ты прекращаешь голосовой вывод и отправляешь ТОЛЬКО JSON-текст:
   {
     "status": "success" | "suspicious",
     "damages": ["царапина на бампере", "скол на стекле"],
     "fraud_check": "passed" | "failed",
     "summary": "Текст вывода..."
   }
                        `
                    }]
                }
            }
        };
        geminiWs.send(JSON.stringify(initialSetup));
    });

    geminiWs.on('message', (data) => {
        // Forward message from Gemini to Client
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    geminiWs.on('close', () => {
        console.log('Gemini WebSocket closed');
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    geminiWs.on('error', (error) => {
        console.error('Gemini WebSocket error:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    // Handle messages from Client
    ws.on('message', (message) => {
        // Forward message from Client to Gemini
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(message);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
