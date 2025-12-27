const WebSocket = require('ws');

class GeminiLiveController {
    constructor(wsClient) {
        this.wsClient = wsClient;
        this.geminiWs = null;
        this.isGeminiReady = false;
        this.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    }

    handleClientMessage(data) {
        try {
            // Step 1: Check data type
            let text = '';
            let isJson = false;

            if (typeof data === 'string') {
                text = data;
                if (text.trim().startsWith('{')) isJson = true;
            } else if (Buffer.isBuffer(data)) {
                // Check if it's a JSON string in a buffer
                const str = data.toString('utf8');
                if (str.trim().startsWith('{')) {
                    text = str;
                    isJson = true;
                }
            }

            if (isJson) {
                const cmd = JSON.parse(text);

                if (cmd.type === 'setup') {
                    console.log("Received setup command");
                    // Assuming setup command might contain scenario info if needed,
                    // but for now just connecting.
                    this.connectToGemini();
                    return; // EXIT, do not send to Gemini yet
                }

                // Forward other JSON messages if ready
                if (this.isGeminiReady && this.geminiWs && this.geminiWs.readyState === WebSocket.OPEN) {
                    this.geminiWs.send(data);
                }
                return;
            }

            // Step 2: Buffer (Audio/Media)
            // If we are here, it's likely binary data or non-setup JSON that failed parsing (unlikely if isJson check passed)
            // But based on the prompt, we treat non-setup as potential audio/media

            if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN || !this.isGeminiReady) {
                // IGNORE data if not ready.
                return;
            }

            // IF TRUE: Wrap in JSON (realtime_input -> media_chunks) and send.
            // Note: The client currently sends JSON for audio. If the client is updated to send Buffer, this handles it.
            // If the client sends JSON audio, it's handled in the 'isJson' block above.
            // This block handles raw binary if the client starts sending it.

            if (Buffer.isBuffer(data)) {
                const base64Audio = data.toString('base64');
                const msg = {
                    realtime_input: {
                        media_chunks: [{
                            mime_type: "audio/pcm",
                            data: base64Audio
                        }]
                    }
                };
                this.geminiWs.send(JSON.stringify(msg));
            }

        } catch (e) {
            console.error("Error in handleClientMessage:", e);
        }
    }

    connectToGemini() {
        if (!this.GEMINI_API_KEY) {
            console.error("Error: GEMINI_API_KEY is missing.");
            this.wsClient.send(JSON.stringify({ type: "error", message: "Server API Key missing" }));
            this.wsClient.close();
            return;
        }

        this.geminiWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.GEMINI_API_KEY}`);

        this.geminiWs.on('open', () => {
            console.log("Connected to Gemini Live"); // Matches criteria: "Connected to Gemini Live"

            const setupMsg = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generation_config: {
                        response_modalities: ["AUDIO"],
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

            this.geminiWs.send(JSON.stringify(setupMsg));
            this.isGeminiReady = true;

            // Send initial greeting (Wake up)
            // Note: The task didn't explicitly ask to remove this, but "Gatekeeper" implies we control the flow.
            // The previous code sent this immediately after setup.
            const wakeUpMsg = {
                 client_content: {
                     turns: [{ parts: [{ text: "Здравствуйте, я готов к осмотру." }], role: "user" }],
                     turn_complete: true
                 }
            };
            this.geminiWs.send(JSON.stringify(wakeUpMsg));
        });

        this.geminiWs.on('message', (data) => {
            try {
                const strData = data.toString();
                const json = JSON.parse(strData);

                // Feedback: If text field exists, send to client as { type: 'text', content: '...' }
                if (json.serverContent?.modelTurn?.parts) {
                    for (const part of json.serverContent.modelTurn.parts) {
                        if (part.text) {
                            this.wsClient.send(JSON.stringify({ type: 'text', content: part.text }));
                        }
                        // Handle functionCall
                        if (part.functionCall) {
                            const { name, args } = part.functionCall;
                            if (name === 'submit_report') {
                                console.log("Gemini called submit_report tool", args);
                                this.wsClient.send(JSON.stringify({ type: 'report', text: JSON.stringify(args) }));
                            }
                        }
                    }
                }

                // Forward everything to client (including audio)
                this.wsClient.send(data);

            } catch (e) {
                console.error("Error processing Gemini message:", e);
                this.wsClient.send(data);
            }
        });

        this.geminiWs.on('close', (code, reason) => {
            console.log(`Gemini connection closed. Code: ${code}, Reason: ${reason}`);
            this.isGeminiReady = false;
            if (this.wsClient.readyState === WebSocket.OPEN) {
                 if (code !== 1000) {
                     this.wsClient.send(JSON.stringify({ type: "error", message: "Gemini connection closed unexpectedly" }));
                 }
                 this.wsClient.close();
            }
        });

        this.geminiWs.on('error', (err) => {
            console.error("Gemini Error:", err);
            this.isGeminiReady = false;
            if (this.wsClient.readyState === WebSocket.OPEN) {
                this.wsClient.send(JSON.stringify({ type: "error", message: "Error connecting to AI service" }));
            }
        });
    }

    handleClose() {
        if (this.geminiWs && this.geminiWs.readyState === WebSocket.OPEN) {
            this.geminiWs.close();
        }
        this.isGeminiReady = false;
    }
}

module.exports = GeminiLiveController;
