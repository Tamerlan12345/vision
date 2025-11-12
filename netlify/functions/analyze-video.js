const fetch = require('node-fetch');

exports.handler = async (event) => {
    console.log('Function invoked.');
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        console.log('Parsing event body...');
        const { video } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error('API key is missing.');
            return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
        }
        if (!video) {
            console.error('No video data provided in the request.');
            return { statusCode: 400, body: JSON.stringify({ error: 'No video provided.' }) };
        }
        console.log('Successfully parsed video data.');

        const model = 'gemini-1.5-flash-latest';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const videoMimeType = video.substring(5, video.indexOf(';'));
    const pureBase64 = video.split(',')[1];

    const prompt = `You are an expert AI vehicle damage inspector. Analyze the provided video of a car walkaround. Your task is twofold:
Assess Video Quality: First, determine if the video is suitable for a reliable damage assessment. Check for:
1.  **Completeness and Trajectory**: The video MUST show a full, continuous 360-degree walkaround of the car. The movement must be in a single direction (e.g., clockwise). Reject the video if the operator moves back and forth, reverses direction, or fails to capture the entire vehicle.
2.  **Clarity**: Is the video sharp and in focus? Reject if it's blurry.
3.  **Steadiness**: Is the camera movement smooth, not jerky or too fast? Reject if the motion is unstable.
4.  **Lighting & Obstructions**: Is it daytime with clear, even lighting? Reject for significant glares, deep shadows, or if parts of the car are obscured.
Identify and Detail Damages: If, and only if, the video quality is acceptable, meticulously identify every single damage on the vehicle.
STRICT OUTPUT FORMAT: Your response must be a single JSON object. Do not include any text before or after the JSON. All user-facing strings MUST be in Russian.

JSON Structure: { "quality_assessment": { "is_acceptable": BOOLEAN, "reason": "STRING" // Если неприемлемо, укажите четкую, краткую причину на РУССКОМ (например, 'Неполный обход автомобиля.', 'Движение камеры слишком резкое, изображение размыто.', 'Обход автомобиля был выполнен не в одном направлении.'). Если приемлемо, это может быть 'Хорошее качество для анализа.' }, "damages": [ // An empty array [] if quality is not acceptable. // ... остальная структура без изменений ... ] } `;

    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                { inline_data: { mime_type: videoMimeType, data: pureBase64 } }
            ]
        }],
        generationConfig: {
            responseMimeType: "application/json",
        }
    };

    console.log(`Video MIME type: ${videoMimeType}`);
    // Temporarily log the payload MINUS the video data for security
    const payloadForLogging = { ...payload, contents: [{ parts: [{ text: "prompt..." }, { inline_data: { mime_type: videoMimeType, data: "video_data_omitted" } }] }] };
    console.log('Sending payload to Gemini API:', JSON.stringify(payloadForLogging, null, 2));


    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        const clientMessage = `Gemini API Error (Status: ${response.status}): ${errorBody}`;
        return { statusCode: 502, body: JSON.stringify({ error: 'Failed to get a response from the AI model.', "client-facing-error": clientMessage }) };
    }

    const result = await response.json();


    if (!result.candidates || result.candidates.length === 0) {
        const feedback = result.promptFeedback ? JSON.stringify(result.promptFeedback) : 'No feedback available.';
        const clientMessage = `AI model returned no content. This is often due to safety filters. Feedback: ${feedback}`;
         return {
            statusCode: 422,
            body: JSON.stringify({
                error: 'The AI model returned no content, possibly due to safety filters.',
                "client-facing-error": clientMessage
            }),
        };
    }

    const analysisText = result.candidates[0].content.parts[0].text;

    try {
        const analysisJson = JSON.parse(analysisText);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ analysis: analysisJson }),
        };
    } catch(e) {
        const clientMessage = `Failed to parse AI response as JSON. Error: ${e.message}. Received text: "${analysisText.substring(0, 100)}..."`;
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to parse the AI response.',
                "client-facing-error": clientMessage
            })
        };
    }

} catch (error) {
    console.error('Error in Netlify function:', error);
    // Check for timeout error specifically if possible (depends on environment)
    const isTimeout = error.message.includes('timed out') || error.constructor.name === 'TimeoutError';
    const clientMessage = isTimeout
        ? 'Анализ видео занял слишком много времени. Попробуйте записать видео покороче.'
        : 'Произошла внутренняя ошибка сервера. Пожалуйста, попробуйте позже.';

    return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message, "client-facing-error": clientMessage }),
    };
}
};
