require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const analyzeController = require('./controllers/analyze');
const analyzeVideoController = require('./controllers/analyzeVideo');
const GeminiLiveController = require('./controllers/user/GeminiLiveController');

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
    console.log("Client connected. Initializing Controller...");

    const controller = new GeminiLiveController(wsClient);

    wsClient.on('message', (data) => {
        controller.handleClientMessage(data);
    });

    wsClient.on('close', () => {
        console.log("Client disconnected.");
        controller.handleClose();
    });

    wsClient.on('error', (err) => {
        console.error("Client WebSocket Error:", err);
        controller.handleClose();
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
