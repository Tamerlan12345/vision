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
    const processingStatus = document.getElementById('processing-status');

    // State variables
    let userMediaRecorder, carMediaRecorder;
    let userChunks = [], carChunks = [];
    let currentStream;
    let carTimerInterval;
    let carSecondsElapsed = 0;
    const USER_VIDEO_DURATION = 5; // 5 seconds

    // --- Core Functions ---

    const showScreen = (screenName) => {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        if (screens[screenName]) {
            screens[screenName].classList.add('active');
        }
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
        startUserRecording();
    });

    async function startUserRecording() {
        showScreen('userVideo');
        try {
            currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            userVideoPreview.srcObject = currentStream;

            userMediaRecorder = new MediaRecorder(currentStream);
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
                        userMediaRecorder.stop();
                    }
                }
            }, 1000);

        } catch (err) {
            console.error("Error accessing front camera:", err);
            showErrorMessage("Не удалось получить доступ к фронтальной камере. Пожалуйста, проверьте разрешения.");
            showScreen('start');
        }
    }

    async function startCarRecording() {
        showScreen('recording');
        try {
            // Constrain video resolution to reduce file size
            const constraints = {
                video: {
                    facingMode: 'environment',
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                },
                audio: false
            };
            currentStream = await navigator.mediaDevices.getUserMedia(constraints);
            carVideoPreview.srcObject = currentStream;

            carMediaRecorder = new MediaRecorder(currentStream);
            carMediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) carChunks.push(e.data);
            };
            carMediaRecorder.onstop = processVideos; // Process both videos when this one stops

            carMediaRecorder.start();

            // Timer for car video
            carSecondsElapsed = 0;
            carTimerDisplay.textContent = formatTime(carSecondsElapsed);
            carTimerInterval = setInterval(() => {
                carSecondsElapsed++;
                carTimerDisplay.textContent = formatTime(carSecondsElapsed);
                if (carSecondsElapsed >= 60) { // Max duration
                    stopRecording();
                }
            }, 1000);

        } catch (err) {
            console.error("Error accessing rear camera:", err);
            showErrorMessage("Не удалось получить доступ к основной камере. Пожалуйста, проверьте разрешения.");
            showScreen('start');
        }
    }

    stopBtn.addEventListener('click', () => {
        if (carMediaRecorder && carMediaRecorder.state === 'recording') {
            carMediaRecorder.stop();
        }
        clearInterval(carTimerInterval);
        stopAllStreams();
        showScreen('processing');
    });


    // --- Processing and Results ---

    async function processVideos() {
        processingStatus.textContent = 'Обработка видео и извлечение кадров...';

        const userVideoBlob = new Blob(userChunks, { type: 'video/webm' });
        const carVideoBlob = new Blob(carChunks, { type: 'video/webm' });

        // Check video size before processing
        const MAX_SIZE_MB = 4.5;
        if (carVideoBlob.size > MAX_SIZE_MB * 1024 * 1024) {
            showErrorMessage(`Видео слишком большое (${(carVideoBlob.size / 1024 / 1024).toFixed(1)}MB). Пожалуйста, запишите видео короче ${MAX_SIZE_MB}MB.`);
            // still show the frames and video player, just don't analyze
            showScreen('results');
            resultsContent.classList.remove('hidden');
            resultsSummary.textContent = "Анализ отменен из-за размера видео.";
            return;
        }

        // Free up memory
        userChunks = [];
        carChunks = [];

        try {
            // Extract frames
            const userFramePromise = extractFrame(userVideoBlob, USER_VIDEO_DURATION / 2);
            const carDuration = carSecondsElapsed;
            const carFrame1_promise = extractFrame(carVideoBlob, carDuration * 0.1);
            const carFrame2_promise = extractFrame(carVideoBlob, carDuration * 0.4);
            const carFrame3_promise = extractFrame(carVideoBlob, carDuration * 0.7);
            const carFrame4_promise = extractFrame(carVideoBlob, carDuration * 0.95);

            const [userFrame, carFrame1_img, carFrame2_img, carFrame3_img, carFrame4_img] = await Promise.all([
                userFramePromise, carFrame1_promise, carFrame2_promise, carFrame3_promise, carFrame4_promise
            ]);

            // Display frames and video
            userPhotoResult.src = userFrame;
            carFrame1.src = carFrame1_img;
            carFrame2.src = carFrame2_img;
            carFrame3.src = carFrame3_img;
            carFrame4.src = carFrame4_img;
            resultVideo.src = URL.createObjectURL(carVideoBlob);

            // Convert car video to Base64 for analysis
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result;
                analyzeVideo(base64data);
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
            video.muted = true;
            video.playsInline = true;
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const videoUrl = URL.createObjectURL(videoBlob);

            video.onloadedmetadata = () => {
                video.currentTime = timeInSeconds;
            };

            video.onseeked = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg'));
                URL.revokeObjectURL(videoUrl);
            };

            video.onerror = (e) => {
                reject(new Error('Failed to load video for frame extraction.'));
                URL.revokeObjectURL(videoUrl);
            };

            video.src = videoUrl;
        });
    }

    async function analyzeVideo(videoBase64) {
        processingStatus.textContent = 'Загрузка видео на сервер...';
        try {
            const response = await fetch('/.netlify/functions/analyze-video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ video: videoBase64 }),
            });

            processingStatus.textContent = 'Анализ видео... Это может занять несколько минут.';

            if (!response.ok) {
                const err = await response.json();
                // Prefer the specific client-facing error message if it exists
                throw new Error(err['client-facing-error'] || err.error || 'Ошибка сервера');
            }

            const result = await response.json();
            displayResults(result.analysis);
            showScreen('results');

        } catch (error) {
            console.error('Error during analysis:', error);
            showErrorMessage(error.message);
            showScreen('results');
        }
    }

    function displayResults(analysis) {
        resultsContent.classList.remove('hidden');

        if (!analysis) {
            showErrorMessage("Не удалось получить результаты анализа.");
            return;
        }

        if (analysis.quality_assessment && !analysis.quality_assessment.is_acceptable) {
            resultsSummary.textContent = "Видео не прошло проверку качества.";
            const reason = document.createElement('p');
            reason.textContent = `Причина: ${analysis.quality_assessment.reason}`;
            resultsContainer.appendChild(reason);
        }

        if (analysis.damages && analysis.damages.length > 0) {
            resultsSummary.textContent = `Найдено повреждений: ${analysis.damages.length}`;
            analysis.damages.forEach(damage => {
                const item = document.createElement('div');
                item.className = 'damage-item';
                item.innerHTML = `
                    <p><strong>Деталь:</strong> ${damage.part}</p>
                    <p><strong>Тип:</strong> ${damage.type}</p>
                    <p><strong>Описание:</strong> ${damage.description}</p>
                    <p><strong>Время в видео:</strong> ${damage.timestamp}s</p>
                `;
                resultsContainer.appendChild(item);
            });
        } else if (analysis.quality_assessment && analysis.quality_assessment.is_acceptable) {
            resultsSummary.textContent = "Повреждений не найдено.";
        }
    }

    function showErrorMessage(message) {
        errorMessage.textContent = `Ошибка: ${message}`;
        errorMessage.style.display = 'block';
    }
});
