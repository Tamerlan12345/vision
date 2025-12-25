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

    // Новые переменные для записи видео и кадров
    let mediaRecorder;
    let recordedChunks = [];
    let snapshots = [];
    let snapshotInterval;

    async function initAudioContext() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
    }

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
                if (data instanceof Blob) {
                     data = await data.text();
                }
                const json = JSON.parse(data);

                if (json.serverContent?.modelTurn?.parts) {
                    const parts = json.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.text) {
                            if (part.text.includes('damages') || part.text.includes('FINISH_REPORT')) {
                                handleReport(part.text);
                                stopInspection();
                            }
                        } else if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                            const base64Audio = part.inlineData.data;
                            handleAudioResponse(base64Audio);
                            updateStatus('ИИ говорит', 'status-speaking');
                            setTimeout(() => updateStatus('Слушаю', 'status-listening'), 2000);
                        }
                    }
                } else if (json.type === 'report') {
                     handleReport(json.text);
                     stopInspection();
                }
            } catch (e) {
                console.error("Error processing message:", e);
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
        const binaryString = window.atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const int16Data = new Int16Array(bytes.buffer);
        const floatData = new Float32Array(int16Data.length);
        for (let i = 0; i < int16Data.length; i++) {
             floatData[i] = int16Data[i] / 32768.0;
        }
        const buffer = audioContext.createBuffer(1, floatData.length, 24000);
        buffer.getChannelData(0).set(floatData);
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        const currentTime = audioContext.currentTime;
        if (nextAudioTime < currentTime) nextAudioTime = currentTime;
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
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 16000 },
                video: { width: { ideal: 640 }, facingMode: 'environment' }
            });

            videoPreview.srcObject = stream;
            isRecording = true;

            // --- Local Recording & Snapshots ---
            recordedChunks = [];
            snapshots = [];
            // Проверяем поддерживаемый MIME type
            const mimeType = MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
                           ? "video/webm; codecs=vp9"
                           : "video/webm";

            mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };
            mediaRecorder.start();

            // Делаем снапшоты каждые 3 секунды
            snapshotInterval = setInterval(() => {
                captureSnapshot();
            }, 3000);

            // --- Streaming to AI ---
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const pcm16 = floatTo16BitPCM(inputData);
                const base64Audio = arrayBufferToBase64(pcm16.buffer);
                ws.send(JSON.stringify({
                    realtime_input: { media_chunks: [{ mime_type: "audio/pcm", data: base64Audio }] }
                }));
            };

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            videoInterval = setInterval(() => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;
                if (videoPreview.videoWidth === 0) return;

                canvas.width = videoPreview.videoWidth;
                canvas.height = videoPreview.videoHeight;
                ctx.drawImage(videoPreview, 0, 0);

                // Качество 0.5 для скорости передачи
                const base64Img = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                ws.send(JSON.stringify({
                    realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: base64Img }] }
                }));
            }, 500); // 2 FPS для ИИ

        } catch (err) {
            console.error('Error accessing media:', err);
            errorText.textContent = `Ошибка доступа к камере/микрофону: ${err.message}`;
            stopInspection();
        }
    }

    function captureSnapshot() {
        if (!videoPreview.videoWidth) return;
        const canvas = document.createElement('canvas');
        canvas.width = videoPreview.videoWidth;
        canvas.height = videoPreview.videoHeight;
        canvas.getContext('2d').drawImage(videoPreview, 0, 0);
        snapshots.push(canvas.toDataURL('image/jpeg', 0.8));
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

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (snapshotInterval) clearInterval(snapshotInterval);

        if (ws) ws.close();
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (audioContext) audioContext.close();
        if (videoInterval) clearInterval(videoInterval);

        startBtn.disabled = false;
        stopBtn.disabled = true;
        updateStatus('Завершено', 'status-waiting');
    }

    function handleReport(text) {
        reportContainer.style.display = 'block';

        // 1. Отображение видео и кадров
        let mediaHtml = '<h3>Запись осмотра</h3>';

        // Видео
        if (recordedChunks.length > 0) {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const videoUrl = URL.createObjectURL(blob);
            mediaHtml += `<div style="margin-bottom: 20px;"><video src="${videoUrl}" controls style="width: 100%; max-width: 600px; border-radius: 8px;"></video></div>`;
        }

        // Раскадровка
        if (snapshots.length > 0) {
            mediaHtml += '<h4>Ключевые кадры (Раскадровка)</h4><div style="display: flex; gap: 10px; overflow-x: auto; padding-bottom: 10px;">';
            snapshots.forEach((snap, idx) => {
                mediaHtml += `<img src="${snap}" style="height: 100px; border-radius: 4px; border: 1px solid #ccc;">`;
            });
            mediaHtml += '</div>';
        }

        // 2. Парсинг и отображение JSON отчета
        let jsonHtml = '';
        try {
            // Очистка от markdown (```json ... ```)
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();

            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                text = text.substring(firstBrace, lastBrace + 1);
            }

            const json = JSON.parse(text);

            let tableHtml = '<table border="1" style="width:100%; border-collapse: collapse; margin-top: 15px;">';
            if (json.damages && json.damages.length > 0) {
                tableHtml += '<tr style="background:#f4f4f4;"><th style="padding:8px;">Деталь</th><th style="padding:8px;">Тип</th><th style="padding:8px;">Важность</th></tr>';
                json.damages.forEach(d => {
                    tableHtml += `<tr>
                        <td style="padding:8px;">${d.part || '-'}</td>
                        <td style="padding:8px;">${d.type || '-'}</td>
                        <td style="padding:8px;">${d.severity || '-'}</td>
                    </tr>`;
                });
                tableHtml += '</table>';
            } else {
                tableHtml = '<p>Повреждений не найдено.</p>';
            }

            let summaryHtml = '';
            if (json.summary) {
                summaryHtml = `<div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin: 10px 0;"><strong>Итог ИИ:</strong> ${json.summary}</div>`;
            }

            jsonHtml = summaryHtml + tableHtml;

        } catch (e) {
            console.warn("JSON Parse Error:", e);
            jsonHtml = `<p><strong>Сырой ответ ИИ:</strong> ${text}</p>`;
        }

        reportContent.innerHTML = mediaHtml + jsonHtml;
    }

    // --- Event Listeners ---
    startBtn.addEventListener('click', () => {
        errorText.textContent = '';
        reportContainer.style.display = 'none';
        connectWebSocket();
    });

    stopBtn.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
             const msg = {
                 client_content: {
                     turns: [{ parts: [{ text: "FINISH_REPORT" }], role: "user" }],
                     turn_complete: true
                 }
            };
            ws.send(JSON.stringify(msg));
            updateStatus('Генерация отчета...', 'status-waiting');
            // Даем пару секунд на генерацию и потом закрываем, или ждем ответа
        } else {
            stopInspection();
        }
    });
});
