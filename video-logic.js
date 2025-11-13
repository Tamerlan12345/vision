document.addEventListener('DOMContentLoaded', () => {
    // Screen elements
    const screens = {
        start: document.getElementById('screen-start'),
        userVideo: document.getElementById('screen-user-video'),
        recording: document.getElementById('screen-recording'),
        processing: document.getElementById('screen-processing'),
        results: document.getElementById('screen-results'),
    };

    // Button elements
    const startBtn = document.getElementById('start-recording-btn');
    const stopBtn = document.getElementById('stop-recording-btn');

    // Video preview elements
    const userVideoPreview = document.getElementById('user-video-preview');
    const carVideoPreview = document.getElementById('video-preview');

    // Timer elements
    const userVideoTimerDisplay = document.getElementById('user-video-timer');
    const carTimerDisplay = document.getElementById('timer');

    // Results elements
    const resultsContent = document.getElementById('results-content');
    const userPhotoResult = document.getElementById('user-photo-result');
    const resultVideo = document.getElementById('result-video');
    const carFrame1 = document.getElementById('car-frame-1');
    const carFrame2 = document.getElementById('car-frame-2');
    const carFrame3 = document.getElementById('car-frame-3');
    const carFrame4 = document.getElementById('car-frame-4');
    const resultsSummary = document.getElementById('results-summary');
    const resultsContainer = document.getElementById('results-container');
    const errorMessage = document.getElementById('error-message');
    const errorText = document.getElementById('error-text');
    const errorDetails = document.getElementById('error-details');
    const processingStatus = document.getElementById('processing-status');

    // State variables
    let userMediaRecorder, carMediaRecorder;
    let userChunks = [], carChunks = [];
    let currentStream;

    // Expose for testing
    window.testing = {
        get a_userMediaRecorder() { return userMediaRecorder; },
        get a_carMediaRecorder() { return carMediaRecorder; }
    };
    let carTimerInterval;
    let carSecondsElapsed = 0;
    const USER_VIDEO_DURATION = 5; // 5 seconds
    let mimeType; // To store the supported MIME type
    let pollingInterval; // To store the interval for status checks

    // --- Core Functions ---

    const getSupportedMimeType = () => {
        // Prioritize MP4 for broader compatibility, especially on iOS.
        // Safari on iOS often records in a WebM container that is not easily parsable by FFMPEG on the server.
        const possibleTypes = [
            'video/mp4',
            'video/webm; codecs="vp8, opus"',
            'video/webm',
        ];
        // Return the first supported type, or an empty string to let the browser decide.
        return possibleTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
    };

    const showScreen = (screenName) => {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        if (screens[screenName]) {
            screens[screenName].classList.add('active');
        }
        // Clear any previous error messages when changing screens
        errorMessage.style.display = 'none';
        errorMessage.textContent = '';
    };

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    };

    const stopAllStreams = () => {
        if (currentStream) {
            currentStream.getTracks().forEach(track => track.stop());
        }
    };

    // --- Recording Flow ---

    startBtn.addEventListener('click', () => {
        try {
            mimeType = getSupportedMimeType();
            console.log(`Using MIME type: ${mimeType}`);
            startUserRecording();
        } catch (error) {
            console.error("Error setting up recording:", error);
            showErrorMessage(error.message);
            showScreen('start');
        }
    });

    async function startUserRecording() {
        showScreen('userVideo');
        try {
            // Attempt to get the user-facing camera, with a fallback to any camera
            try {
                currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            } catch (err) {
                if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
                    console.warn("User camera not found, trying any camera...");
                    currentStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                } else {
                    throw err;
                }
            }
            userVideoPreview.srcObject = currentStream;

            userMediaRecorder = new MediaRecorder(currentStream, { mimeType });
            userMediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) userChunks.push(e.data);
            };
            userMediaRecorder.onstop = () => {
                stopAllStreams();
                startCarRecording(); // Automatically start next step
            };

            userMediaRecorder.start();

            // Timer for user video
            let userSecondsLeft = USER_VIDEO_DURATION;
            userVideoTimerDisplay.textContent = `Осталось: ${userSecondsLeft} сек`;
            const userTimer = setInterval(() => {
                userSecondsLeft--;
                userVideoTimerDisplay.textContent = `Осталось: ${userSecondsLeft} сек`;
                if (userSecondsLeft <= 0) {
                    clearInterval(userTimer);
                    if (userMediaRecorder.state === 'recording') {
                        console.log('Timer elapsed. Stopping user video recording.');
                        userMediaRecorder.stop();
                    }
                }
            }, 1000);

        } catch (err) {
            console.error("Critical error in startUserRecording:", err);
            let errorMessage = "Не удалось получить доступ к фронтальной камере. Пожалуйста, проверьте разрешения.";
            if (err.name) {
                errorMessage += ` (Ошибка: ${err.name})`;
            }
            console.error("Error accessing front camera:", err.name, err.message);
            showErrorMessage(errorMessage);
            showScreen('start');
        }
    }

    async function startCarRecording() {
        showScreen('recording');
        try {
             // Attempt to get the environment-facing camera, with a fallback
            let streamConstraints = { video: { facingMode: 'environment' }, audio: false };
            try {
                currentStream = await navigator.mediaDevices.getUserMedia(streamConstraints);
            } catch (err) {
                if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
                    console.warn("Environment camera not found, trying any camera...");
                    streamConstraints = { video: true, audio: false }; // Fallback
                    currentStream = await navigator.mediaDevices.getUserMedia(streamConstraints);
                } else {
                    throw err;
                }
            }
            carVideoPreview.srcObject = currentStream;

            carMediaRecorder = new MediaRecorder(currentStream, { mimeType });
            carMediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) carChunks.push(e.data);
            };
            carMediaRecorder.onstop = processVideos;

            carMediaRecorder.start();

            carSecondsElapsed = 0;
            carTimerDisplay.textContent = formatTime(carSecondsElapsed);
            carTimerInterval = setInterval(() => {
                carSecondsElapsed++;
                carTimerDisplay.textContent = formatTime(carSecondsElapsed);
                if (carSecondsElapsed >= 60) {
                    stopRecording();
                }
            }, 1000);

        } catch (err) {
            let errorMessage = "Не удалось получить доступ к основной камере. Пожалуйста, проверьте разрешения.";
            if (err.name) {
                errorMessage += ` (Ошибка: ${err.name})`;
            }
            console.error("Error accessing rear camera:", err.name, err.message);
            showErrorMessage(errorMessage);
            showScreen('start');
        }
    }

    const stopRecording = () => {
        if (carMediaRecorder && carMediaRecorder.state === 'recording') {
            carMediaRecorder.stop();
        }
        clearInterval(carTimerInterval);
        stopAllStreams();
        showScreen('processing');
    };

    stopBtn.addEventListener('click', stopRecording);

    // --- Processing and Results ---

    async function processVideos() {
        processingStatus.textContent = 'Обработка видео и извлечение кадров...';

        const userVideoBlob = new Blob(userChunks, { type: mimeType });
        const carVideoBlob = new Blob(carChunks, { type: mimeType });

        const MAX_SIZE_MB = 50;
        if (carVideoBlob.size > MAX_SIZE_MB * 1024 * 1024) {
            showErrorMessage(`Видео слишком большое (${(carVideoBlob.size / 1024 / 1024).toFixed(1)}MB). Пожалуйста, запишите видео короче ${MAX_SIZE_MB}MB.`);
            showScreen('results');
            resultsContent.classList.remove('hidden');
            resultsSummary.textContent = "Анализ отменен из-за размера видео.";
            return;
        }

        userChunks = [];
        carChunks = [];

        try {
            const [userFrame, carFrame1_img, carFrame2_img, carFrame3_img, carFrame4_img] = await Promise.all([
                extractFrame(userVideoBlob, USER_VIDEO_DURATION / 2),
                extractFrame(carVideoBlob, carSecondsElapsed * 0.1),
                extractFrame(carVideoBlob, carSecondsElapsed * 0.4),
                extractFrame(carVideoBlob, carSecondsElapsed * 0.7),
                extractFrame(carVideoBlob, carSecondsElapsed * 0.95),
            ]);

            userPhotoResult.src = userFrame;
            carFrame1.src = carFrame1_img;
            carFrame2.src = carFrame2_img;
            carFrame3.src = carFrame3_img;
            carFrame4.src = carFrame4_img;
            resultVideo.src = URL.createObjectURL(carVideoBlob);

            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result;
                startAnalysisJob(base64data);
            };
            reader.readAsDataURL(carVideoBlob);

        } catch (error) {
            console.error('Error processing videos:', error);
            showErrorMessage('Произошла ошибка при обработке видео.');
            showScreen('results');
        }
    }

    function extractFrame(videoBlob, timeInSeconds) {
        return new Promise((resolve, reject) => {
            const video = document.createElement('video');
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const videoUrl = URL.createObjectURL(videoBlob);

            // Configure video element
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.src = videoUrl;

            let cleanedUp = false;

            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                // Revoke the object URL to prevent memory leaks
                URL.revokeObjectURL(videoUrl);
                // Remove event listeners to avoid orphaned callbacks
                video.onloadedmetadata = null;
                video.onseeked = null;
                video.onerror = null;
                video.remove(); // Remove the video element from memory
                canvas.remove(); // Remove the canvas element
            };

            video.onloadedmetadata = () => {
                // Set the time only after metadata is loaded
                if (timeInSeconds > video.duration) {
                    console.warn(`Seek time (${timeInSeconds}) is greater than video duration (${video.duration}). Clamping to duration.`);
                    video.currentTime = video.duration - 0.1; // Seek to just before the end
                } else {
                    video.currentTime = timeInSeconds;
                }
            };

            video.onseeked = () => {
                // Ensure video dimensions are valid before drawing
                if (video.videoWidth > 0 && video.videoHeight > 0) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataUrl = canvas.toDataURL('image/jpeg');
                    resolve(dataUrl);
                } else {
                    // This can happen on some browsers if the frame is not ready
                    reject(new Error('Failed to get valid video dimensions for frame extraction.'));
                }
                cleanup();
            };

            video.onerror = (e) => {
                // Provide more specific error information
                let errorMsg = 'Failed to load video for frame extraction.';
                if (video.error) {
                    errorMsg += ` Code: ${video.error.code}, Message: ${video.error.message}`;
                }
                reject(new Error(errorMsg));
                cleanup();
            };

            // Safety timeout in case the events never fire
            setTimeout(() => {
                if (!cleanedUp) {
                    reject(new Error('Frame extraction timed out.'));
                    cleanup();
                }
            }, 10000); // 10 seconds timeout
        });
    }

    async function startAnalysisJob(videoBase64) {
        processingStatus.textContent = 'Загрузка видео на сервер...';
        try {
            const response = await fetch('/.netlify/functions/upload-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video: videoBase64 }),
            });

            // Even if the request is "ok", it might contain an error message
            const responseBody = await response.text();
            if (!response.ok) {
                // Construct a detailed error message
                throw new Error(`Ошибка загрузки: ${response.status} ${response.statusText}. Ответ сервера: ${responseBody}`);
            }

            const { jobId } = JSON.parse(responseBody);
            if (!jobId) {
                throw new Error('Не удалось получить ID задачи для анализа.');
            }

            processingStatus.textContent = 'Видео загружено. Ожидание начала обработки...';
            pollStatus(jobId);

        } catch (error) {
            console.error('Error starting analysis job:', error);
            showErrorMessage(error.message);
            showScreen('results');
        }
    }

    function pollStatus(jobId) {
        if (pollingInterval) clearInterval(pollingInterval);

        pollingInterval = setInterval(async () => {
            try {
                const response = await fetch(`/.netlify/functions/check-status?jobId=${jobId}`);
                 const responseBody = await response.text();

                if (!response.ok) {
                    clearInterval(pollingInterval);
                    // Try to parse for more details, but fall back to text
                    let errorDetails = responseBody;
                    try {
                        const errorJson = JSON.parse(responseBody);
                        errorDetails = errorJson.error || JSON.stringify(errorJson);
                    } catch(e) { /* Ignore parsing error */ }
                    throw new Error(`Ошибка проверки статуса: ${response.status} ${response.statusText}. Детали: ${errorDetails}`);
                }

                const data = JSON.parse(responseBody);

                switch (data.status) {
                    case 'pending':
                        processingStatus.textContent = 'Ожидание в очереди на обработку...';
                        break;
                    case 'processing':
                        let stageText = 'Обработка видео...';
                        if (data.stage === 'converting') stageText = 'Конвертация формата видео...';
                        else if (data.stage === 'analyzing') stageText = 'Анализ повреждений...';
                        else if (data.stage) stageText = `Шаг: ${data.stage}...`;
                        processingStatus.textContent = stageText;
                        break;
                    case 'complete':
                        clearInterval(pollingInterval);
                        processingStatus.textContent = 'Анализ завершен!';
                        displayResults(data.analysis);
                        showScreen('results');
                        break;
                    case 'error':
                        clearInterval(pollingInterval);
                        // Use the new client-facing error if available
                        const errorMessage = data['client-facing-error'] || data.message || 'Произошла неизвестная ошибка на сервере.';
                        throw new Error(errorMessage);
                }
            } catch (error) {
                clearInterval(pollingInterval);
                console.error('Error polling status:', error);
                showErrorMessage(error.message);
                showScreen('results');
            }
        }, 3000); // Poll every 3 seconds
    }

    function displayResults(analysis) {
        resultsContent.classList.remove('hidden');
        resultsContainer.innerHTML = ''; // Clear previous results

        if (!analysis) {
            showErrorMessage("Не удалось получить результаты анализа.");
            return;
        }

        if (analysis.quality_assessment && !analysis.quality_assessment.is_acceptable) {
            resultsSummary.textContent = "Видео не прошло проверку качества.";
            const reason = document.createElement('p');
            reason.textContent = `Причина: ${analysis.quality_assessment.reason}`;
            resultsContainer.appendChild(reason);
        } else if (analysis.damages && analysis.damages.length > 0) {
            resultsSummary.textContent = `Найдено повреждений: ${analysis.damages.length}`;
            analysis.damages.forEach(damage => {
                const item = document.createElement('div');
                item.className = 'damage-item';
                item.innerHTML = `
                    <p><strong>Деталь:</strong> ${damage.part}</p>
                    <p><strong>Тип:</strong> ${damage.type}</p>
                    <p><strong>Описание:</strong> ${damage.description}</p>
                `;
                resultsContainer.appendChild(item);
            });
        } else {
             resultsSummary.textContent = "Повреждений не найдено.";
        }
    }

    function showErrorMessage(fullMessage) {
        let mainMessage = 'Произошла ошибка';
        let details = fullMessage;

        // Try to parse structured error messages from the server
        const detailMarker = '. Ответ сервера:';
        const statusMarker = '. Детали:';
        if (fullMessage.includes(detailMarker)) {
            const parts = fullMessage.split(detailMarker);
            mainMessage = parts[0];
            details = parts[1];
        } else if (fullMessage.includes(statusMarker)) {
             const parts = fullMessage.split(statusMarker);
            mainMessage = parts[0];
            details = parts[1];
        }

        console.error(`Displaying error: ${mainMessage}`, `Details: ${details}`);

        errorText.textContent = mainMessage;
        errorDetails.textContent = details;
        errorMessage.style.display = 'block';
        resultsContent.classList.add('hidden'); // Hide results content on error
    }
});
