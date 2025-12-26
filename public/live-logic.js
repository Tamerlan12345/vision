document.addEventListener('DOMContentLoaded', () => {
    const videoPreview = document.getElementById('video-preview');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const statusIndicator = document.getElementById('status-indicator');
    const reportContainer = document.getElementById('report-section');
    const cameraSection = document.getElementById('camera-section');
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
        // ВАЖНО: Не закрываем AudioContext сразу, иначе не услышим вывод!
        // if (audioContext) audioContext.close();
        if (videoInterval) clearInterval(videoInterval);

        startBtn.disabled = false;
        stopBtn.disabled = true;
        updateStatus('Завершено', 'status-waiting');
    }

    function handleReport(text) {
        let data;
        try {
            // Очистка от markdown (```json ... ```)
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();

            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                text = text.substring(firstBrace, lastBrace + 1);
            }
            data = JSON.parse(text);
        } catch (e) {
            console.error("JSON parse error", e);
            // Fallback for raw text
            reportContent.innerHTML = `<p><strong>Ошибка парсинга отчета:</strong> ${text}</p>`;
            stopInspection();
            reportContainer.style.display = 'block';
            if (cameraSection) cameraSection.style.display = 'none';
            return;
        }

        // 1. ОСТАНОВКА ИНТЕРАКТИВА
        stopInspection();

        // 2. ГЕНЕРАЦИЯ HTML ОТЧЕТА
        // Блок статуса
        const statusColor = data.status === 'aborted' ? '#dc3545' : '#28a745';
        const statusText = data.status === 'aborted' ? 'ОСМОТР ПРЕРВАН' : 'ОСМОТР ЗАВЕРШЕН';

        let html = `
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: ${statusColor};">${statusText}</h2>
                <p>${data.summary || ''}</p>
            </div>
        `;

        // Блок Фрод-факторов (Риски)
        if (data.fraud_factors && data.fraud_factors.length > 0) {
            html += `
            <div class="fraud-alert" style="background: #fff3cd; border: 1px solid #ffeeba; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <h3 style="color: #856404; margin-top: 0;">⚠️ Обнаружены факторы риска</h3>
                <ul>
                    ${data.fraud_factors.map(f => `<li>${f}</li>`).join('')}
                </ul>
            </div>`;
        }

        // Блок Таблица повреждений
        if (data.damages && data.damages.length > 0) {
            html += `<h3>Найденные повреждения</h3>
            <table border="1" style="width:100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr style="background: #f8f9fa;"><th>Деталь</th><th>Тип</th><th>Тяжесть</th></tr>
                ${data.damages.map(d => `<tr><td>${d.part}</td><td>${d.type}</td><td>${d.severity}</td></tr>`).join('')}
            </table>`;
        }

        // Блок Галерея (Снапшоты)
        if (snapshots && snapshots.length > 0) {
            html += `
            <h3>Материалы осмотра</h3>
            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                ${snapshots.map(src =>
                    `<img src="${src}" style="width: 100px; height: 75px; object-fit: cover; border: 1px solid #ddd; border-radius: 4px;">`
                ).join('')}
            </div>`;
        }

        reportContent.innerHTML = html;

        // Показать модальное окно или секцию отчета
        reportContainer.style.display = 'block';
        if (cameraSection) cameraSection.style.display = 'none'; // Скрыть камеру
    }

    // Expose handleReport to window for testing/verification
    window.handleReport = handleReport;

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
