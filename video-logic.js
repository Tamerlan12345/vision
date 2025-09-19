document.addEventListener('DOMContentLoaded', () => {
    const screens = {
        start: document.getElementById('screen-start'),
        recording: document.getElementById('screen-recording'),
        processing: document.getElementById('screen-processing'),
        results: document.getElementById('screen-results'),
    };

    const startRecordingBtn = document.getElementById('start-recording-btn');
    const stopRecordingBtn = document.getElementById('stop-recording-btn');
    const videoPreview = document.getElementById('video-preview');
    const processingStatus = document.getElementById('processing-status');
    const resultsContainer = document.getElementById('results-container');
    const errorMessage = document.getElementById('error-message');
    const resultsSummary = document.getElementById('results-summary');
    const timerDisplay = document.getElementById('timer');

    let mediaRecorder;
    let recordedChunks = [];
    let stream;
    let timerInterval;
    let secondsElapsed = 0;

    const showScreen = (screenName) => {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        screens[screenName].classList.add('active');
    };

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
        const secs = (seconds % 60).toString().padStart(2, '0');
        return `${mins}:${secs}`;
    };

    const stopRecording = () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        clearInterval(timerInterval);
        showScreen('processing');
    };

    startRecordingBtn.addEventListener('click', async () => {
        showScreen('recording');
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
            videoPreview.srcObject = stream;
            mediaRecorder = new MediaRecorder(stream);
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };
            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: 'video/webm' });
                recordedChunks = [];
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64data = reader.result;
                    analyzeVideo(base64data);
                };
                reader.readAsDataURL(blob);
            };
            mediaRecorder.start();

            secondsElapsed = 0;
            timerDisplay.textContent = formatTime(secondsElapsed);
            timerInterval = setInterval(() => {
                secondsElapsed++;
                timerDisplay.textContent = formatTime(secondsElapsed);
                if (secondsElapsed >= 60) {
                    stopRecording();
                }
            }, 1000);

        } catch (err) {
            console.error("Error accessing camera:", err);
            showErrorMessage("Не удалось получить доступ к камере. Пожалуйста, проверьте разрешения.");
            showScreen('start');
        }
    });

    stopRecordingBtn.addEventListener('click', () => {
        stopRecording();
    });

    async function analyzeVideo(videoBase64) {
        processingStatus.textContent = 'Загрузка видео на сервер...';
        try {
            const response = await fetch('/.netlify/functions/analyze-video', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ video: videoBase64 }),
            });

            processingStatus.textContent = 'Анализ видео... Это может занять несколько минут.';

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Ошибка сервера');
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
        if (!analysis) {
            showErrorMessage("Не удалось получить результаты анализа.");
            return;
        }

        if (analysis.quality_assessment && !analysis.quality_assessment.is_acceptable) {
            resultsSummary.textContent = "Видео не прошло проверку качества.";
            const reason = document.createElement('p');
            reason.textContent = `Причина: ${analysis.quality_assessment.reason}`;
            resultsContainer.appendChild(reason);
            const suggestion = document.createElement('p');
            suggestion.innerHTML = "Пожалуйста, попробуйте перезаписать видео, следуя инструкциям на главном экране.";
            resultsContainer.appendChild(suggestion);
            return;
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
        } else {
            resultsSummary.textContent = "Повреждений не найдено.";
        }
    }

    function showErrorMessage(message) {
        errorMessage.textContent = `Ошибка: ${message}`;
        errorMessage.style.display = 'block';
    }
});
