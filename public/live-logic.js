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
    let isRecording = false; // Флаг отправки данных на сервер
    let nextAudioTime = 0;

    // Флаг успешного завершения осмотра (получен отчет)
    let inspectionCompleted = false;

    // Переменные для локальной записи и снапшотов
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
        // Сброс флага при новом подключении
        inspectionCompleted = false;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/live-inspection`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket Connected');
            updateStatus('Идет осмотр', 'status-listening');
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

                if (json.type === 'error') {
                     // Обработка явной ошибки от сервера
                     console.error("Server error:", json.message);
                     updateStatus(`Ошибка: ${json.message}`, 'status-error');
                     // Если это ошибка, осмотр не считается успешным
                     stopInspectionFull(false);
                     return;
                }

                if (json.serverContent?.modelTurn?.parts) {
                    const parts = json.serverContent.modelTurn.parts;
                    for (const part of parts) {
                        if (part.text) {
                            // Проверяем, не является ли текст JSON-отчетом
                            if (part.text.includes('"type": "report"') || part.text.includes('damages')) {
                                inspectionCompleted = true; // Отчет получен
                                handleReport(part.text);
                                stopInspectionFull(); // Полная остановка
                            }
                        } else if (part.inlineData && part.inlineData.mimeType.startsWith('audio/')) {
                            // Воспроизводим аудио только если мы еще не завершили осмотр
                            if (reportContainer.style.display === 'none') {
                                const base64Audio = part.inlineData.data;
                                handleAudioResponse(base64Audio);
                                updateStatus('ИИ говорит', 'status-speaking');
                                setTimeout(() => {
                                    if(isRecording) updateStatus('Идет осмотр', 'status-listening');
                                }, 2000);
                            }
                        }
                    }
                } else if (json.type === 'report') {
                     inspectionCompleted = true; // Отчет получен
                     handleReport(json.text);
                     stopInspectionFull();
                }
            } catch (e) {
                console.error("Error processing message:", e);
            }
        };

        ws.onclose = (event) => {
            console.log('WebSocket Closed', event.code, event.reason);

            // Если соединение закрыто, проверяем был ли получен отчет
            if (inspectionCompleted) {
                 updateStatus('Осмотр завершен', 'status-success');
                 // Можно добавить зеленый цвет через стиль, если нет класса status-success
                 statusIndicator.style.color = 'green';
            } else {
                 updateStatus('Связь потеряна', 'status-error');
                 statusIndicator.style.color = 'red';
                 errorText.textContent = 'Соединение с сервером разорвано.';
            }

            stopInspectionFull(false); // false = не обновлять статус "Завершено" внутри функции
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            errorText.textContent = 'Ошибка соединения с сервером.';
            updateStatus('Ошибка соединения', 'status-error');
            stopInspectionFull(false);
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

        // Сброс inline стилей, если они были установлены
        if (className !== 'status-success' && className !== 'status-error') {
             statusIndicator.style.color = '';
        }
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

            // Локальная запись
            recordedChunks = [];
            snapshots = [];
            const mimeType = MediaRecorder.isTypeSupported("video/webm; codecs=vp9")
                           ? "video/webm; codecs=vp9"
                           : "video/webm";

            mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };
            mediaRecorder.start();

            // Снапшоты
            snapshotInterval = setInterval(() => {
                if(isRecording) captureSnapshot();
            }, 3000);

            // Потоковая передача аудио
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

            // Потоковая передача видео (кадры)
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
            errorText.textContent = `Ошибка доступа к камере: ${err.message}`;
            updateStatus('Ошибка доступа к камере', 'status-error');
            stopInspectionFull(false);
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

    // Частичная остановка (только запись), но оставляем WS открытым для приема отчета
    function stopRecordingOnly() {
        isRecording = false; // Блокируем отправку данных в onaudioprocess и setInterval

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        if (snapshotInterval) clearInterval(snapshotInterval);
        if (videoInterval) clearInterval(videoInterval);

        // Визуально глушим видео, чтобы пользователь понял, что запись остановлена
        if (videoPreview.srcObject) {
            videoPreview.style.opacity = '0.5';
        }
    }

    // Полная остановка и очистка ресурсов
    function stopInspectionFull(updateStatusText = true) {
        stopRecordingOnly();

        if (ws) {
            ws.onclose = null; // убираем хендлер чтобы не зациклиться
            ws.close();
        }
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (audioContext) audioContext.close();

        startBtn.disabled = false;
        stopBtn.disabled = true;

        if (updateStatusText) {
             updateStatus('Завершено', 'status-waiting');
        }
    }

    function handleReport(text) {
        // Очистка от Markdown и лишнего текста
        let cleanText = text;

        // 1. Убираем блоки кода ```json ... ```
        cleanText = cleanText.replace(/```json/gi, '').replace(/```/g, '');

        // 2. Ищем JSON объект от { до }
        const firstBrace = cleanText.indexOf('{');
        const lastBrace = cleanText.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace !== -1) {
            cleanText = cleanText.substring(firstBrace, lastBrace + 1);
        }

        let data;
        try {
            data = JSON.parse(cleanText);
        } catch (e) {
            console.error("JSON parse error:", e);
            console.log("Raw text received:", text);
            reportContent.innerHTML = `<p style="color:red;"><strong>Ошибка обработки отчета:</strong> ИИ вернул некорректные данные.</p><pre>${text}</pre>`;
            reportContainer.style.display = 'block';
            if (cameraSection) cameraSection.style.display = 'none';
            stopInspectionFull();
            return;
        }

        // ГЕНЕРАЦИЯ HTML ОТЧЕТА
        const statusColor = data.status === 'aborted' ? '#dc3545' : '#28a745';
        const statusText = data.status === 'aborted' ? 'ОСМОТР ПРЕРВАН' : 'ОСМОТР ЗАВЕРШЕН';

        let html = `
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: ${statusColor};">${statusText}</h2>
                <p><strong>Резюме:</strong> ${data.summary || 'Нет описания'}</p>
            </div>
        `;

        if (data.fraud_factors && data.fraud_factors.length > 0) {
            html += `
            <div class="fraud-alert" style="background: #fff3cd; border: 1px solid #ffeeba; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <h3 style="color: #856404; margin-top: 0;">⚠️ Внимание</h3>
                <ul>
                    ${data.fraud_factors.map(f => `<li>${f}</li>`).join('')}
                </ul>
            </div>`;
        }

        if (data.damages && data.damages.length > 0) {
            html += `<h3>Найденные повреждения</h3>
            <table border="1" style="width:100%; border-collapse: collapse; margin-bottom: 20px;">
                <tr style="background: #f8f9fa;">
                    <th style="padding: 8px;">Деталь</th>
                    <th style="padding: 8px;">Тип</th>
                    <th style="padding: 8px;">Описание</th>
                </tr>
                ${data.damages.map(d => `
                    <tr>
                        <td style="padding: 8px;">${d.part}</td>
                        <td style="padding: 8px;">${d.type}</td>
                        <td style="padding: 8px;">${d.description || '-'}</td>
                    </tr>`).join('')}
            </table>`;
        } else {
             html += `<div style="padding: 15px; background: #e8f5e9; border-radius: 8px; color: #2e7d32; margin-bottom: 20px;">Повреждений не обнаружено.</div>`;
        }

        if (snapshots && snapshots.length > 0) {
            html += `
            <h3>Снимки процесса</h3>
            <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                ${snapshots.map(src =>
                    `<img src="${src}" style="width: 100px; height: 75px; object-fit: cover; border: 1px solid #ddd; border-radius: 4px;">`
                ).join('')}
            </div>`;
        }

        reportContent.innerHTML = html;
        reportContainer.style.display = 'block';
        if (cameraSection) cameraSection.style.display = 'none';

        // Мы уже завершили (получили отчет), так что можно закрывать соединение.
        // Передаем false чтобы не перезаписать "Осмотр завершен" на "Завершено"
        stopInspectionFull(false);
    }

    // --- Event Listeners ---
    startBtn.addEventListener('click', () => {
        errorText.textContent = '';
        reportContainer.style.display = 'none';
        cameraSection.style.display = 'block';
        if (videoPreview) videoPreview.style.opacity = '1';

        updateStatus('Подключение к ИИ...', 'status-waiting'); // Сразу меняем статус
        connectWebSocket();
    });

    stopBtn.addEventListener('click', () => {
        // 1. Мгновенно прекращаем запись (UX)
        stopRecordingOnly();
        updateStatus('Генерация отчета... Пожалуйста, подождите.', 'status-waiting');

        // 2. Отправляем сигнал завершения на сервер
        if (ws && ws.readyState === WebSocket.OPEN) {
             const msg = {
                 client_content: {
                     turns: [{ parts: [{ text: "FINISH_REPORT" }], role: "user" }],
                     turn_complete: true
                 }
            };
            ws.send(JSON.stringify(msg));
        } else {
            // Если сокет уже закрыт, просто останавливаемся
            stopInspectionFull();
        }
    });
});
