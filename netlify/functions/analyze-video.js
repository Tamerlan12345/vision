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

    const prompt = `You are an expert AI vehicle damage inspector. Analyze the provided video of a car walkaround (360 degrees). Your task is twofold:
Assess Video Quality: First, determine if the video is suitable for a reliable damage assessment. Check for:
Good Lighting: Is it daytime with clear, even lighting?
Clarity: Is the video sharp and in focus?
Completeness: Does the video show a full 360-degree view of the car?
Steadiness: Is the camera movement smooth, not jerky or too fast?
Obstructions: Are there significant glares, shadows, or other things obscuring the view?
Identify and Detail Damages: If the video quality is acceptable, meticulously identify every single damage on the vehicle. For each unique damage found, provide a detailed report.
STRICT OUTPUT FORMAT: Your response must be a single JSON object. Do not include any text before or after the JSON. All user-facing strings (like 'reason', 'part', 'type', and 'description') MUST be in Russian.

JSON Structure: { "quality_assessment": { "is_acceptable": BOOLEAN, "reason": "STRING" // Если неприемлемо, укажите четкую, краткую причину для пользователя на РУССКОМ ЯЗЫКЕ (например, 'Видео слишком темное.', 'Движение камеры слишком резкое.', 'На видео не видно автомобиль.'). Если приемлемо, это может быть 'Хорошее качество для анализа.' }, "damages": [ // This should be an array of objects. ONLY if quality is acceptable. If not, this is an empty array []. // Each object represents a unique damage. If the same scratch is seen from two angles, it should only appear once. { "id": INTEGER, // A unique ID for each damage, starting from 1. "part": "STRING", // Название детали НА РУССКОМ (e.g., 'Передний бампер', 'Капот', 'Левая передняя дверь') "type": "STRING", // Тип повреждения НА РУССКОМ (e.g., 'Вмятина', 'Царапина', 'Скол', 'Трещина') "description": "STRING", // Детальное описание НА РУССКОМ. "timestamp": FLOAT, // The timestamp in seconds (e.g., 15.3) where the damage is most clearly visible for the first time. "segmentation_polygon": [ { "x": FLOAT, "y": FLOAT }, ... ] // Polygon points (0.0-100.0) on the frame at the given timestamp. } ] } `;

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
