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

    // Для управления аудио-источниками (чтобы можно было их остановить)
    let activeAudioSources = [];

    // Переменные для записи видео и кадров
    let mediaRecorder;
    let recordedChunks = [];
    let snapshots = [];
    let snapshotInterval;
    let audioDestination; // Узел для записи смешанного звука

    async function initAudioContext() {
        // Создаем контекст
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

        // Создаем "пункт назначения" для записи, куда будем направлять и микрофон, и голос ИИ
        audioDestination = audioContext.createMediaStreamDestination();

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
                            if (part.text.includes('damages') || part.text.includes('type": "report"')) {
                                handleReport(part.text);
                            }
                        } else if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                            // Если мы уже не записываем (нажали стоп), не воспроизводить новое аудио
                            if (!isRecording && !stopBtn.disabled) return;

                            const base64Audio = part.inlineData.data;
                            handleAudioResponse(base64Audio);
                            updateStatus('ИИ говорит', 'status-speaking');
                            // Сброс статуса через примерное время (можно улучшить, зная длительность)
                            setTimeout(() => {
                                if(isRecording) updateStatus('Слушаю', 'status-listening');
                            }, 3000);
                        }
                    }
                } else if (json.type === 'report') {
                     handleReport(json.text);
                }
            } catch (e) {
                console.error("Error processing message:", e);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket Closed');
            // Если соединение закрылось само, но мы еще не формировали отчет - останавливаемся
            if (isRecording) stopInspection();
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            errorText.textContent = 'Ошибка соединения с сервером.';
            stopInspection();
        };
    }

    function handleAudioResponse(base64Data) {
        if (!audioContext) return;

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

        const source = audioContext.createBufferSource();
        source.buffer = buffer;

        // 1. Подключаем к динамикам (чтобы слышал пользователь)
        source.connect(audioContext.destination);
        // 2. Подключаем к destination записи (чтобы попало в видео)
        source.connect(audioDestination);

        const currentTime = audioContext.currentTime;
        if (nextAudioTime < currentTime) nextAudioTime = currentTime;
        source.start(nextAudioTime);
        nextAudioTime += buffer.duration;

        // Сохраняем ссылку на источник, чтобы можно было остановить
        source.onended = () => {
            activeAudioSources = activeAudioSources.filter(s => s !== source);
        };
        activeAudioSources.push(source);
    }

    function stopAllAudio() {
        // Останавливаем все активные источники речи
        activeAudioSources.forEach(source => {
            try { source.stop(); } catch(e) {}
        });
        activeAudioSources = [];

        // Сбрасываем планировщик времени
        if(audioContext) nextAudioTime = audioContext.currentTime;
    }

    function updateStatus(text, className) {
        statusIndicator.textContent = `Статус: ${text}`;
        statusIndicator.className = className;
    }

    // --- Media Capture ---

    async function startMediaCapture() {
        try {
            await initAudioContext();

            // Получаем потоки с микрофона и камеры
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, sampleRate: 16000 },
                video: { width: { ideal: 640 }, facingMode: 'environment' }
            });

            videoPreview.srcObject = stream;
            isRecording = true;

            // --- Настройка записи Видео (Картинка + Микс Звука) ---
            recordedChunks = [];
            snapshots = [];

            // Создаем микс из микрофона пользователя
            const micSource = audioContext.createMediaStreamSource(stream);
            micSource.connect(audioDestination); // Микрофон -> в запись

            // Создаем комбинированный поток: Видео с камеры + Аудио с микшера (Мик + ИИ)
            const combinedStream = new MediaStream([
                ...stream.getVideoTracks(),
                ...audioDestination.stream.getAudioTracks()
            ]);

            const mimeType = MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
                           ? "video/webm; codecs=vp9"
                           : "video/webm";

            mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };
            mediaRecorder.start();

            // Снапшоты каждые 2 секунды для "нарезки"
            snapshotInterval = setInterval(() => {
                captureSnapshot();
            }, 2000);

            // --- Потоковая передача аудио на ИИ (только микрофон) ---
            // Для ИИ нам нужен только голос пользователя, без голоса самого ИИ (эхоподавление)
            // Поэтому берем micSource отдельно
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            micSource.connect(processor);
            processor.connect(audioContext.destination); // hack for chrome to activate processor

            processor.onaudioprocess = (e) => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const pcm16 = floatTo16BitPCM(inputData);
                const base64Audio = arrayBufferToBase64(pcm16.buffer);
                ws.send(JSON.stringify({
                    realtime_input: { media_chunks: [{ mime_type: "audio/pcm", data: base64Audio }] }
                }));
            };

            // Отправка кадров на ИИ
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            videoInterval = setInterval(() => {
                if (!isRecording || ws.readyState !== WebSocket.OPEN) return;
                if (videoPreview.videoWidth === 0) return;

                canvas.width = videoPreview.videoWidth;
                canvas.height = videoPreview.videoHeight;
                ctx.drawImage(videoPreview, 0, 0);

                const base64Img = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
                ws.send(JSON.stringify({
                    realtime_input: { media_chunks: [{ mime_type: "image/jpeg", data: base64Img }] }
                }));
            }, 500);

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
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoPreview, 0, 0);
        // Добавим timestamp на фото
        ctx.fillStyle = "white";
        ctx.font = "16px Arial";
        ctx.fillText(new Date().toLocaleTimeString(), 10, 20);
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

        // Останавливаем запись
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (snapshotInterval) clearInterval(snapshotInterval);
        if (videoInterval) clearInterval(videoInterval);

        // Закрываем сокет
        if (ws) ws.close();

        // Останавливаем потоки камеры
        if (stream) stream.getTracks().forEach(track => track.stop());

        // Важно: не закрываем аудиоконтекст полностью, пока не проиграем прощание (если нужно),
        // но здесь мы решили прерывать всё.
        stopAllAudio();

        startBtn.disabled = false;
        stopBtn.disabled = true;
        updateStatus('Завершено', 'status-waiting');
    }

    function handleReport(text) {
        // Останавливаем всё немедленно
        stopInspection();
        stopAllAudio();

        let data;
        try {
            // Очистка от markdown
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                text = text.substring(firstBrace, lastBrace + 1);
            }
            data = JSON.parse(text);
        } catch (e) {
            console.error("JSON parse error", e);
            reportContent.innerHTML = `<p class="error-message">Ошибка обработки отчета. Сырые данные: ${text}</p>`;
            finalizeUI();
            return;
        }

        // --- ГЕНЕРАЦИЯ HTML ОТЧЕТА ---

        const statusColor = data.status === 'aborted' ? '#dc3545' : '#28a745';
        const statusText = data.status === 'aborted' ? 'ОСМОТР ПРЕРВАН' : 'ОСМОТР УСПЕШНО ЗАВЕРШЕН';

        let html = `
            <div style="text-align: center; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 15px;">
                <h2 style="color: ${statusColor}; margin: 0;">${statusText}</h2>
                <p style="font-size: 1.1em; color: #555;">${data.summary || ''}</p>
            </div>
        `;

        // Фрод-факторы
        if (data.fraud_factors && data.fraud_factors.length > 0) {
            html += `
            <div style="background: #fff3cd; border: 1px solid #ffeeba; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
                <h3 style="color: #856404; margin-top: 0; display:flex; align-items:center;">
                    ⚠️ Фрод-факторы (Риски)
                </h3>
                <ul style="margin-bottom: 0;">
                    ${data.fraud_factors.map(f => `<li>${f}</li>`).join('')}
                </ul>
            </div>`;
        }

        // Таблица повреждений
        if (data.damages && data.damages.length > 0) {
            html += `<h3>📋 Найденные повреждения</h3>
            <div style="overflow-x: auto;">
                <table style="width:100%; border-collapse: collapse; margin-bottom: 25px;">
                    <thead>
                        <tr style="background: #f8f9fa; text-align: left;">
                            <th style="padding: 10px; border: 1px solid #dee2e6;">Деталь</th>
                            <th style="padding: 10px; border: 1px solid #dee2e6;">Тип</th>
                            <th style="padding: 10px; border: 1px solid #dee2e6;">Описание</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.damages.map(d => `
                            <tr>
                                <td style="padding: 10px; border: 1px solid #dee2e6;"><strong>${d.part}</strong></td>
                                <td style="padding: 10px; border: 1px solid #dee2e6;">${d.type}</td>
                                <td style="padding: 10px; border: 1px solid #dee2e6;">${d.description}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
        } else {
            html += `<p style="color: green; font-weight: bold;">✅ Повреждений не обнаружено.</p>`;
        }

        // Видео осмотра
        // Создаем Blob из записанных чанков
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        const videoUrl = URL.createObjectURL(blob);

        html += `
        <div style="margin-bottom: 30px;">
            <h3>🎥 Полная видеозапись осмотра (со звуком)</h3>
            <p style="font-size: 0.9em; color: #666;">Запись включает ваш голос и ответы ассистента.</p>
            <video controls src="${videoUrl}" style="width: 100%; border-radius: 8px; background: #000;"></video>
            <a href="${videoUrl}" download="inspection-video.webm" style="display:inline-block; margin-top:5px; color: #0055A5;">Скачать видео</a>
        </div>
        `;

        // Галерея (Покадровая нарезка)
        if (snapshots && snapshots.length > 0) {
            html += `
            <h3>📷 Покадровая нарезка (Хронология)</h3>
            <p style="font-size: 0.9em; color: #666;">Кадры, сделанные автоматически каждые 2 секунды:</p>
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px;">
                ${snapshots.map((src, idx) =>
                    `<div style="text-align: center;">
                        <img src="${src}" onclick="window.open(this.src)" style="width: 100%; aspect-ratio: 4/3; object-fit: cover; border: 1px solid #ddd; border-radius: 4px; cursor: pointer;">
                        <span style="font-size: 10px; color: #777;">Кадр ${idx+1}</span>
                    </div>`
                ).join('')}
            </div>`;
        }

        reportContent.innerHTML = html;
        finalizeUI();
    }

    function finalizeUI() {
        reportContainer.style.display = 'block';
        cameraSection.style.display = 'none';

        // Прокрутка к отчету
        reportContainer.scrollIntoView({ behavior: 'smooth' });
    }

    // --- Listeners ---
    startBtn.addEventListener('click', () => {
        errorText.textContent = '';
        reportContainer.style.display = 'none';
        connectWebSocket();
    });

    stopBtn.addEventListener('click', () => {
        // МГНОВЕННОЕ ПРЕРЫВАНИЕ АССИСТЕНТА
        stopAllAudio();

        if (ws && ws.readyState === WebSocket.OPEN) {
             const msg = {
                 client_content: {
                     turns: [{ parts: [{ text: "FINISH_REPORT" }], role: "user" }],
                     turn_complete: true
                 }
            };
            ws.send(JSON.stringify(msg));
            updateStatus('Анализ и генерация отчета...', 'status-waiting');
            stopBtn.disabled = true; // Блокируем кнопку, чтобы не жали дважды
        } else {
            stopInspection();
        }
    });
});
