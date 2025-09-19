const fetch = require('node-fetch');

exports.handler = async (event) => { if (event.httpMethod !== 'POST') { return { statusCode: 405, body: 'Method Not Allowed' }; }

try {
    const { video } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
    }
    if (!video) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No video provided.' }) };
    }

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

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        console.error('API Error:', response.status, errorBody);
        throw new Error('Failed to get a response from the AI model.');
    }

    const result = await response.json();

    if (!result.candidates || result.candidates.length === 0) {
        console.warn('Response from API was blocked or empty.', result.promptFeedback);
         return {
            statusCode: 500,
            body: JSON.stringify({ error: 'The AI model could not process the video. This might be due to a safety filter. Please try a different video.' }),
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
        console.error("JSON Parsing Error:", e, "Received text:", analysisText);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to parse the AI response.' }) };
    }

} catch (error) {
    console.error('Error in Netlify function:', error);
    return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
    };
}
};
