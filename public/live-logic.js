document.addEventListener('DOMContentLoaded', () => {
    const videoPreview = document.getElementById('video-preview');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusIndicator = document.getElementById('status-indicator');
    const reportContainer = document.getElementById('reportContainer');
    const reportContent = document.getElementById('report-content');
    const errorText = document.getElementById('error-text');

    let ws;
    let audioContext;
    let stream;
    let videoInterval;
    let isRecording = false;
    let nextAudioTime = 0;

    async function initAudioContext() {
        // Create AudioContext at 16kHz if supported.
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
    }

    // Convert Float32Array to Int16Array
    function floatTo16BitPCM(input) {
        const output = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return output;
    }

    // --- WebSocket Logic ---

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/live-inspection`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket Connected');
            updateStatus('Слушаю', 'status-listening');
            startBtn.disabled = true;
            stopBtn.disabled = false;
            startMediaCapture();
        };

        ws.onmessage = async (event) => {
            let data = event.data;

            try {
                // Handle Blob (Server sends Buffer -> Client receives Blob)
                if (data instanceof Blob) {
                     data = await data.text();
                }

                // Now we expect a JSON string
                const json = JSON.parse(data);

                // Check for serverContent -> modelTurn -> parts -> text or inlineData
                if (json.serverContent?.modelTurn?.parts) {
                    const parts = json.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.text) {
                            // It might be a partial text or the final report JSON string
                            // If it looks like the final report JSON structure:
                            if (part.text.includes('"damages":') || part.text.includes('FINISH_REPORT')) {
                                handleReport(part.text);
                                stopInspection();
                            } else {
                                // Just spoken text transcript or unknown
                                console.log("AI Text:", part.text);
                            }
                        } else if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                            // Audio Data!
                            const base64Audio = part.inlineData.data;
                            handleAudioResponse(base64Audio);
                            updateStatus('ИИ говорит', 'status-speaking');
                            setTimeout(() => updateStatus('Слушаю', 'status-listening'), 2000);
                        }
                    }
                } else if (json.type === 'report') {
                     // Custom type if our server wrapper sent it
                     handleReport(json.text);
                     stopInspection();
                } else {
                    // Other metadata (turnComplete, etc.)
                    // console.log("Metadata:", json);
                }

            } catch (e) {
                console.error("Error processing message:", e);
                // If parsing fails, maybe it IS raw audio?
                // But Gemini Bidi API protocol is JSON messages.
            }
        };

        ws.onclose = () => {
            console.log('WebSocket Closed');
            stopInspection();
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            errorText.textContent = 'Ошибка соединения с сервером.';
            stopInspection();
        };
    }

    function handleAudioResponse(base64Data) {
        // Decode Base64 to ArrayBuffer
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Gemini returns PCM 24kHz (usually) or 16kHz depending on config.
        // Assuming 1 channel PCM Int16 (Little Endian).
        const int16Data = new Int16Array(bytes.buffer);
        const floatData = new Float32Array(int16Data.length);

        for (let i = 0; i < int16Data.length; i++) {
             floatData[i] = int16Data[i] / 32768.0;
        }

        // Play it
        // Note: Gemini Voice default is 24000Hz.
        const buffer = audioContext.createBuffer(1, floatData.length, 24000);
        buffer.getChannelData(0).set(floatData);

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);

        const currentTime = audioContext.currentTime;
        if (nextAudioTime < currentTime) {
            nextAudioTime = currentTime;
        }
        source.start(nextAudioTime);
        nextAudioTime += buffer.duration;
    }

    function updateStatus(text, className) {
        statusIndicator.textContent = `Статус: ${text}`;
        statusIndicator.className = className;
    }

    // --- Media Capture ---

    async function startMediaCapture() {
        try {
            await initAudioContext();

            // Get User Media
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000
                },
                video: {
                    width: { ideal: 640 },
                    facingMode: 'environment'
                }
            });

            videoPreview.srcObject = stream;
            isRecording = true;

            // --- Process Audio ---
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);

            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const pcm16 = floatTo16BitPCM(inputData);
                const base64Audio = arrayBufferToBase64(pcm16.buffer);

                const msg = {
                    realtime_input: {
                        media_chunks: [{
                            mime_type: "audio/pcm",
                            data: base64Audio
                        }]
                    }
                };
                ws.send(JSON.stringify(msg));
            };

            // --- Process Video ---
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            videoInterval = setInterval(() => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;

                if (videoPreview.videoWidth === 0) return;

                canvas.width = videoPreview.videoWidth;
                canvas.height = videoPreview.videoHeight;
                ctx.drawImage(videoPreview, 0, 0);

                const base64Img = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];

                 const msg = {
                    realtime_input: {
                        media_chunks: [{
                            mime_type: "image/jpeg",
                            data: base64Img
                        }]
                    }
                };
                ws.send(JSON.stringify(msg));

            }, 500);

        } catch (err) {
            console.error('Error accessing media:', err);
            errorText.textContent = `Ошибка доступа к камере/микрофону: ${err.message}`;
            stopInspection();
        }
    }

    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    function stopInspection() {
        isRecording = false;
        if (ws) {
            ws.close();
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        if (audioContext) {
            audioContext.close();
        }
        if (videoInterval) {
            clearInterval(videoInterval);
        }
        startBtn.disabled = false;
        stopBtn.disabled = true;
        updateStatus('Завершено', 'status-waiting');
    }

    function handleReport(text) {
        reportContainer.style.display = 'block';
        try {
            // Find JSON in text if it's mixed with other text
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                text = text.substring(firstBrace, lastBrace + 1);
            }

            const json = JSON.parse(text);

            let html = '<table border="1" style="width:100%; border-collapse: collapse; margin-top: 10px;">';

            if (json.damages) {
                html += '<tr><th style="padding:8px; text-align:left;">Деталь</th><th style="padding:8px; text-align:left;">Тип</th><th style="padding:8px; text-align:left;">Важность</th></tr>';
                json.damages.forEach(d => {
                    html += `<tr>
                        <td style="padding:8px;">${d.part || '-'}</td>
                        <td style="padding:8px;">${d.type || '-'}</td>
                        <td style="padding:8px;">${d.severity || '-'}</td>
                    </tr>`;
                });
                html += '</table>';
            }

            let summaryHtml = '';
            if (json.summary) {
                summaryHtml = `<div style="margin: 10px 0; font-weight: bold;">${json.summary}</div>`;
            }

            let fraudHtml = '';
            if (json.fraud_detected) {
                fraudHtml = `<div style="color: red; margin: 10px 0;"><strong>ВНИМАНИЕ: Обнаружены признаки мошенничества!</strong><br>Причины: ${json.fraud_reasons.join(', ')}</div>`;
            }

            reportContent.innerHTML = fraudHtml + summaryHtml + html + `<pre style="margin-top:20px; font-size: 0.8em;">RAW: ${JSON.stringify(json, null, 2)}</pre>`;

        } catch (e) {
            // Fallback for non-JSON text
            reportContent.innerHTML = `<p>${text}</p>`;
        }
    }

    // --- Event Listeners ---

    startBtn.addEventListener('click', () => {
        errorText.textContent = '';
        reportContainer.style.display = 'none';
        connectWebSocket();
    });

    stopBtn.addEventListener('click', () => {
        // Send finish command
        if (ws && ws.readyState === WebSocket.OPEN) {
             const msg = {
                 client_content: {
                     turns: [{ parts: [{ text: "FINISH_REPORT" }], role: "user" }],
                     turn_complete: true
                 }
            };
            ws.send(JSON.stringify(msg));
            updateStatus('Генерация отчета...', 'status-waiting');
        } else {
            stopInspection();
        }
    });

});
