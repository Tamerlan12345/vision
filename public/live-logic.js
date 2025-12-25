document.addEventListener('DOMContentLoaded', () => {
    // Screen elements
    const screens = {
        start: document.getElementById('screen-start'),
        live: document.getElementById('screen-live'),
        results: document.getElementById('screen-results'),
    };

    // Button elements
    const startBtn = document.getElementById('start-live-btn');
    const endBtn = document.getElementById('end-inspection-btn');

    // Video preview elements
    const videoPreview = document.getElementById('live-video-preview');

    // Status elements
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    // Results elements
    const resultsContent = document.getElementById('results-content');
    const resultsSummary = document.getElementById('results-summary');
    const fraudStatus = document.getElementById('fraud-status');
    const damagesContainer = document.getElementById('damages-container');
    const errorMessage = document.getElementById('error-message');

    // State variables
    let webSocket = null;
    let audioContext = null;
    let mediaStream = null;
    let videoInterval = null;
    let audioWorkletNode = null;
    let sourceNode = null;

    // Constants
    const SAMPLE_RATE = 16000; // Required by Gemini Live API
    const BUFFER_SIZE = 2048;

    // --- Helper Functions ---

    const showScreen = (screenName) => {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        if (screens[screenName]) {
            screens[screenName].classList.add('active');
        }
    };

    const updateStatus = (status) => {
        statusDot.className = 'status-dot';
        if (status === 'listening') {
            statusDot.classList.add('listening');
            statusText.textContent = 'ИИ слушает...';
        } else if (status === 'speaking') {
            statusDot.classList.add('speaking');
            statusText.textContent = 'ИИ говорит...';
        } else if (status === 'connected') {
            statusText.textContent = 'Подключено';
            statusDot.style.backgroundColor = 'var(--success-color)';
        } else {
            statusText.textContent = 'Подключение...';
        }
    };

    // --- Audio Processing ---

    // Downsample buffer from AudioContext rate to 16000Hz
    function downsampleBuffer(buffer, sampleRate) {
        if (sampleRate === 16000) {
            return buffer;
        }
        const sampleRateRatio = sampleRate / 16000;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Int16Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            let accum = 0, count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            // Clamp to Int16 range
            let val = accum / count;
            val = Math.max(-1, Math.min(1, val));
            result[offsetResult] = val < 0 ? val * 0x8000 : val * 0x7FFF;
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    // Convert Base64 string to Float32Array for playback
    function base64ToAudioBuffer(base64) {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        // Assuming 16-bit PCM LE
        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }
        return float32Array;
    }

    // Play audio chunk
    function playAudioChunk(base64Audio) {
        if (!audioContext) return;

        try {
            const audioData = base64ToAudioBuffer(base64Audio);
            const audioBuffer = audioContext.createBuffer(1, audioData.length, 24000); // Gemini output is 24kHz
            audioBuffer.getChannelData(0).set(audioData);

            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);
            source.start(0);

            updateStatus('speaking');
            source.onended = () => {
                updateStatus('listening');
            };
        } catch (e) {
            console.error("Error playing audio chunk", e);
        }
    }


    // --- WebSocket Logic ---

    const connectWebSocket = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`; // Connect to local server

        console.log(`Connecting to WebSocket: ${wsUrl}`);
        webSocket = new WebSocket(wsUrl);

        webSocket.onopen = () => {
            console.log('WebSocket connected');
            updateStatus('connected');
            endBtn.classList.remove('hidden');
            startAudioStream();
            startVideoStream();
        };

        webSocket.onmessage = async (event) => {
            let data;
            if (event.data instanceof Blob) {
                 data = JSON.parse(await event.data.text());
            } else {
                 data = JSON.parse(event.data);
            }

            if (data.serverContent && data.serverContent.modelTurn) {
                const parts = data.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                         playAudioChunk(part.inlineData.data);
                    } else if (part.text) {
                        // Check if it is the final JSON report
                         try {
                             // Sometimes text might be wrapped in ```json ... ```
                             let jsonText = part.text.replace(/```json|```/g, '').trim();
                             if (jsonText.startsWith('{')) {
                                 const report = JSON.parse(jsonText);
                                 handleFinalReport(report);
                             } else {
                                 console.log("Text message from AI:", part.text);
                             }
                         } catch (e) {
                             console.log("Text message from AI (not JSON):", part.text);
                         }
                    }
                }
            } else if (data.serverContent && data.serverContent.turnComplete) {
                 updateStatus('listening');
            }
        };

        webSocket.onerror = (error) => {
            console.error('WebSocket error:', error);
            showErrorMessage('Ошибка соединения с сервером.');
        };

        webSocket.onclose = () => {
            console.log('WebSocket disconnected');
            stopInspection();
        };
    };

    const sendAudioData = (inputBuffer) => {
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;

        const pcmData = downsampleBuffer(inputBuffer, audioContext.sampleRate);
        const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));

        const message = {
            realtime_input: {
                media_chunks: [{
                    mime_type: "audio/pcm",
                    data: base64Audio
                }]
            }
        };
        webSocket.send(JSON.stringify(message));
    };

    const sendVideoFrame = () => {
        if (!webSocket || webSocket.readyState !== WebSocket.OPEN || !mediaStream) return;

        const canvas = document.createElement('canvas');
        canvas.width = videoPreview.videoWidth;
        canvas.height = videoPreview.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoPreview, 0, 0);

        // Convert to base64 JPEG
        const base64Image = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];

        const message = {
            realtime_input: {
                media_chunks: [{
                    mime_type: "image/jpeg",
                    data: base64Image
                }]
            }
        };
        webSocket.send(JSON.stringify(message));
    };


    // --- Media Capture ---

    startBtn.addEventListener('click', async () => {
        showScreen('live');
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); // Try to set preference, but might be overridden by browser

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: {
                    facingMode: 'environment',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            });

            mediaStream = stream;
            videoPreview.srcObject = stream;

            connectWebSocket();

        } catch (err) {
            console.error("Error accessing media devices:", err);
            showErrorMessage("Не удалось получить доступ к камере или микрофону.");
            showScreen('start');
        }
    });

    const startAudioStream = async () => {
        await audioContext.resume();
        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // Use ScriptProcessorNode for wide compatibility to get raw PCM
        const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

        scriptNode.onaudioprocess = (audioProcessingEvent) => {
             if (webSocket && webSocket.readyState === WebSocket.OPEN) {
                 const inputBuffer = audioProcessingEvent.inputBuffer.getChannelData(0);
                 sendAudioData(inputBuffer);
             }
        };

        sourceNode.connect(scriptNode);
        scriptNode.connect(audioContext.destination); // Needed for the script node to work in some browsers

        // Mute output to avoid feedback loop since we are playing back AI response
        // But scriptNode needs to be connected to destination.
        // We can create a GainNode with 0 gain.
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        scriptNode.connect(gainNode);
        gainNode.connect(audioContext.destination);
    };

    const startVideoStream = () => {
        videoInterval = setInterval(sendVideoFrame, 1000); // Send frame every 1 second
    };

    const stopInspection = () => {
        if (webSocket) {
            webSocket.close();
            webSocket = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        if (videoInterval) {
            clearInterval(videoInterval);
            videoInterval = null;
        }
    };

    endBtn.addEventListener('click', () => {
        stopInspection();
        showScreen('start'); // Or go to results if we have partial results?
    });

    // --- Result Handling ---

    function handleFinalReport(report) {
        stopInspection();
        showScreen('results');
        resultsContent.classList.remove('hidden');

        resultsSummary.textContent = report.summary || "Осмотр завершен.";

        if (report.fraud_check === 'passed') {
            fraudStatus.textContent = "Пройдена";
            fraudStatus.className = "fraud-check-passed";
        } else {
             fraudStatus.textContent = "Не пройдена (Подозрение)";
             fraudStatus.className = "fraud-check-failed";
        }

        damagesContainer.innerHTML = '';
        if (report.damages && report.damages.length > 0) {
            report.damages.forEach(dmg => {
                const div = document.createElement('div');
                div.className = 'damage-item';
                div.textContent = dmg;
                damagesContainer.appendChild(div);
            });
        } else {
            damagesContainer.innerHTML = '<p>Повреждений не обнаружено.</p>';
        }
    }

    function showErrorMessage(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }

});
