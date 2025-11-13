
const { getStore } = require('@netlify/blobs');
const fetch = require('node-fetch');
const ffmpeg = require('ffmpeg-static');
const { exec } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// Helper function to run ffmpeg
const runFfmpeg = (inputPath, outputPath) => {
    return new Promise((resolve, reject) => {
        // Command to convert to a universally compatible MP4 format
        const command = `${ffmpeg} -i ${inputPath} -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k ${outputPath}`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFMPEG Error:', stderr);
                return reject(new Error(`ffmpeg failed: ${stderr}`));
            }
            resolve(outputPath);
        });
    });
};


// Helper to call Gemini API
const callGeminiApi = async (videoBase64, videoMimeType) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');

    const model = 'gemini-1.5-flash-latest';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = `You are an expert AI vehicle damage inspector. Analyze the provided video of a car walkaround. Your task is twofold:
Assess Video Quality: First, determine if the video is suitable for a reliable damage assessment. Check for:
1.  **Completeness and Trajectory**: The video MUST show a full, continuous 360-degree walkaround of the car. The movement must be in a single direction (e.g., clockwise). Reject the video if the operator moves back and forth, reverses direction, or fails to capture the entire vehicle.
2.  **Clarity**: Is the video sharp and in focus? Reject if it's blurry.
3.  **Steadiness**: Is the camera movement smooth, not jerky or too fast? Reject if the motion is unstable.
4.  **Lighting & Obstructions**: Is it daytime with clear, even lighting? Reject for significant glares, deep shadows, or if parts of the car are obscured.
Identify and Detail Damages: If, and only if, the video quality is acceptable, meticulously identify every single damage on the vehicle.
STRICT OUTPUT FORMAT: Your response must be a single JSON object. Do not include any text before or after the JSON. All user-facing strings MUST be in Russian.

JSON Structure: { "quality_assessment": { "is_acceptable": BOOLEAN, "reason": "STRING" // Если неприемлемо, укажите четкую, краткую причину на РУССКОМ (например, 'Неполный обход автомобиля.', 'Движение камеры слишком резкое, изображение размыто.', 'Обход автомобиля был выполнен не в одном направлении.'). Если приемлемо, это может быть 'Хорошее качество для анализа.' }, "damages": [ // An empty array [] if quality is not acceptable or no damages are found. // If damages are found, populate with objects like this: { "part": "STRING // e.g., 'Передний бампер'", "type": "STRING // e.g., 'Царапина', 'Вмятина', 'Скол'", "description": "STRING // A brief, clear description of the damage in Russian." } ] } `;

    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                { inline_data: { mime_type: videoMimeType, data: videoBase64 } }
            ]
        }],
        generationConfig: {
            responseMimeType: "application/json",
        }
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini API Error (Status: ${response.status}): ${errorBody}`);
    }

    const result = await response.json();
    if (!result.candidates || result.candidates.length === 0) {
        const feedback = result.promptFeedback ? JSON.stringify(result.promptFeedback) : 'No feedback available.';
        throw new Error(`AI model returned no content. Feedback: ${feedback}`);
    }

    return JSON.parse(result.candidates[0].content.parts[0].text);
};


exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { jobId } = JSON.parse(event.body);
    if (!jobId) {
        console.error('No jobId provided to background function.');
        return { statusCode: 400, body: 'jobId is required.' };
    }

    console.log(`Starting background processing for job: ${jobId}`);
    const statusStore = getStore('statuses');
    let currentStage = 'setup';

    try {
        await statusStore.setJSON(jobId, { status: 'processing', stage: currentStage, timestamp: new Date().toISOString() });

        const videoStore = getStore('videos');
        const videoBase64WithMime = await videoStore.get(jobId);
        if (!videoBase64WithMime) {
            throw new Error(`Video data not found in blob store for jobId: ${jobId}`);
        }
        console.log(`[${jobId}] Retrieved video from blob store.`);

        const mimeTypeMatch = videoBase64WithMime.match(/^data:(video\/[-a-zA-Z0-9_.+]+);base64,/);
        if (!mimeTypeMatch) {
            // Safari on iOS can produce video/mp4; codecs="hvc1" which is valid. Let's be more lenient.
            // A simple split should be safe enough as we control the client-side code.
            const mimePart = videoBase64WithMime.substring(0, videoBase64WithMime.indexOf(';base64,'));
            if (!mimePart.startsWith('data:video/')) {
                 throw new Error('Could not parse MIME type from data URL. Invalid format.');
            }
             console.log(`[${jobId}] Leniently parsed MIME info: ${mimePart}`);
        } else {
             console.log(`[${jobId}] Matched MIME type: ${mimeTypeMatch[1]}`);
        }
        const base64Data = videoBase64WithMime.split(';base64,').pop();


        currentStage = 'file_system';
        const tempDir = os.tmpdir();
        const inputPath = path.join(tempDir, `${jobId}_input`);
        const outputPath = path.join(tempDir, `${jobId}_output.mp4`);

        await fs.writeFile(inputPath, base64Data, { encoding: 'base64' });
        console.log(`[${jobId}] Wrote temporary input file to ${inputPath}`);

        currentStage = 'converting';
        await statusStore.setJSON(jobId, { status: 'processing', stage: currentStage, timestamp: new Date().toISOString() });
        console.log(`[${jobId}] Starting video conversion with ffmpeg.`);
        await runFfmpeg(inputPath, outputPath);
        console.log(`[${jobId}] Finished video conversion. Output at ${outputPath}`);

        const convertedVideoBuffer = await fs.readFile(outputPath);
        const convertedVideoBase64 = convertedVideoBuffer.toString('base64');
        const convertedMimeType = 'video/mp4';

        currentStage = 'analyzing';
        await statusStore.setJSON(jobId, { status: 'processing', stage: currentStage, timestamp: new Date().toISOString() });
        console.log(`[${jobId}] Calling Gemini API for analysis.`);
        const analysisResult = await callGeminiApi(convertedVideoBase64, convertedMimeType);
        console.log(`[${jobId}] Received analysis from Gemini API.`);

        currentStage = 'saving_results';
        const resultStore = getStore('results');
        await resultStore.setJSON(jobId, {
            status: 'complete',
            analysis: analysisResult,
            timestamp: new Date().toISOString(),
        });

        await statusStore.setJSON(jobId, { status: 'complete', timestamp: new Date().toISOString() });
        console.log(`Job ${jobId} completed successfully.`);

        currentStage = 'cleanup';
        await fs.unlink(inputPath);
        await fs.unlink(outputPath);
        console.log(`[${jobId}] Cleaned up temporary files.`);

        return { statusCode: 200, body: `Job ${jobId} processed.` };

    } catch (error) {
        console.error(`[${jobId}] Error during stage '${currentStage}':`, error);
        await statusStore.setJSON(jobId, {
            status: 'error',
            stage: currentStage,
            message: 'An internal error occurred during processing.',
            // Client-facing-error is what we'll show the user.
            "client-facing-error": `Ошибка на этапе '${currentStage}': ${error.message}`,
            timestamp: new Date().toISOString(),
        });
        return { statusCode: 500, body: `Job ${jobId} failed.` };
    }
};
