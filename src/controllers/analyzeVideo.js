const fetch = require('node-fetch');

exports.handle = async (req, res) => {
    console.log('Analyze video request received.');

    try {
        const { video } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error('API key is missing.');
            return res.status(500).json({ error: 'Server configuration error: API key is missing.' });
        }
        if (!video) {
            console.error('No video data provided in the request.');
            return res.status(400).json({ error: 'No video provided.' });
        }
        console.log('Successfully parsed video data.');

        const model = 'gemini-2.0-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const videoMimeType = video.substring(5, video.indexOf(';'));
        const base64Marker = ';base64,';
        const markerIndex = video.indexOf(base64Marker);
        let pureBase64 = '';
        if (markerIndex !== -1) {
            pureBase64 = video.substring(markerIndex + base64Marker.length);
        } else {
            // Fallback for non-standard or missing base64 marker
            pureBase64 = video.split(',')[1];
        }

        const prompt = `You are an expert AI vehicle damage inspector. Analyze the provided video of a car walkaround. Your task is twofold:

Assess Video Quality: First, determine if the video is suitable for a reliable damage assessment. Be reasonable and lenient with human errors.
1.  **Completeness**: The goal is a 360-degree view. Accept the video if it covers the majority (approx. 75-100%) of the vehicle's perimeter. Even if the start and end points don't perfectly overlap, or if one corner is missed, accept it if the main body panels are visible.
2.  **Trajectory**: Look for a generally circular path. Do NOT reject the video for minor hesitations, slight back-and-forth movements to adjust focus, or shaky hands. Only reject if the video is chaotic or stays on one spot.
3.  **Clarity**: Is the video clear enough to see body panels? Reject only if severe blurriness makes damage detection impossible.
4.  **Lighting**: Reject only if deep darkness or extreme glare prevents seeing the car entirely.

Identify and Detail Damages: If, and only if, the video quality is acceptable (quality_assessment.is_acceptable = true), meticulously identify every single damage on the vehicle.

STRICT OUTPUT FORMAT: Your response must be a single JSON object. Do not include any text before or after the JSON. All user-facing strings MUST be in Russian.

JSON Structure: { "quality_assessment": { "is_acceptable": BOOLEAN, "reason": "STRING" // If rejected, provide a clear reason in Russian. If acceptable, output "Видео принято к анализу." }, "damages": [ // An empty array [] if quality is not acceptable. { "part": "STRING", "type": "STRING", "description": "STRING", "timestamp": "STRING" // approximate timestamp in seconds } ] } `;

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
            return res.status(502).json({ error: 'Failed to get a response from the AI model.', "client-facing-error": clientMessage });
        }

        const result = await response.json();

        if (!result.candidates || result.candidates.length === 0) {
            const feedback = result.promptFeedback ? JSON.stringify(result.promptFeedback) : 'No feedback available.';
            const clientMessage = `AI model returned no content. This is often due to safety filters. Feedback: ${feedback}`;
            return res.status(422).json({
                error: 'The AI model returned no content, possibly due to safety filters.',
                "client-facing-error": clientMessage
            });
        }

        const analysisText = result.candidates[0].content.parts[0].text;

        try {
            const analysisJson = JSON.parse(analysisText);
            return res.status(200).json({ analysis: analysisJson });
        } catch(e) {
            const clientMessage = `Failed to parse AI response as JSON. Error: ${e.message}. Received text: "${analysisText.substring(0, 100)}..."`;
            return res.status(500).json({
                error: 'Failed to parse the AI response.',
                "client-facing-error": clientMessage
            });
        }

    } catch (error) {
        console.error('Error in analyze-video controller:', error);
        // Check for timeout error specifically if possible (depends on environment)
        const isTimeout = error.message.includes('timed out') || error.constructor.name === 'TimeoutError';
        const clientMessage = isTimeout
            ? 'Анализ видео занял слишком много времени. Попробуйте записать видео покороче.'
            : 'Произошла внутренняя ошибка сервера. Пожалуйста, попробуйте позже.';

        return res.status(500).json({ error: error.message, "client-facing-error": clientMessage });
    }
};
