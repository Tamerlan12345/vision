const fetch = require('node-fetch');

exports.handle = async (req, res) => {
    try {
        const { photos, minConfidence: reqMinConfidence } = req.body;
        const minConfidence = reqMinConfidence !== undefined ? parseInt(reqMinConfidence, 10) : 65;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            console.error('GEMINI_API_KEY is not set in environment variables.');
            return res.status(500).json({ error: 'Server configuration error: API key is missing.' });
        }

        if (!photos || Object.keys(photos).length === 0) {
            return res.status(400).json({ error: 'No photos provided for analysis.' });
        }

        // 3. Define API details
        const model = 'gemini-2.0-flash';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const finalResults = {};
        let totalDamageCounter = 1;

        // UPDATED PROMPT: Focus on precise segmentation and strict JSON
        const finalPrompt = `You are a world-class automotive damage assessment expert. Your task is to conduct a meticulous analysis of the provided car image.

GOAL: Identify ALL defects (dents, scratches, scuffs, cracks, rust) and outline them with EXTREME PRECISION.

SEGMENTATION RULES:

Precision is Paramount: Do NOT approximate. The polygon must follow the exact jagged edge of the damage.

No Bounding Boxes: Never draw a simple box or circle around the damage.

Tight Fit: Imagine wrapping the damage in shrink-wrap. There should be ZERO gap between the polygon line and the actual damage pixels.

Complex Shapes: If a scratch is curved or 'S' shaped, the polygon must follow that curve exactly using multiple points. Do not cut corners.

Chain of Thought for Analysis:
1.  **Scan**: Examine the image for any anomalies in surface reflection, texture, or color.
2.  **Verify**: Distinguish actual damage from dirt, reflections, or design elements.
3.  **Segment (CRITICAL)**: Trace the EXACT contour of the damage.
    * For a **scratch**: The polygon must be thin and follow the line of the scratch exactly. Do NOT draw a box around it.
    * For a **dent**: Trace the distorted area only, excluding normal reflections.
    * **Precision**: The polygon points must hug the edges of the damage tightly. No "air" or loose padding.
    * **Density**: Use more points to describe curved lines.
4.  **Describe**: Determine the part name, damage type, and specific location in Russian.

STRICT OUTPUT REQUIREMENTS:
* Response must be ONLY a valid JSON array.
* No markdown, no code blocks, no text outside the JSON.
* If no damage is found, return \`[]\`.
* **All user-facing strings must be in Russian.**

JSON Structure per damage:
{
  "part": "STRING (Название детали, e.g., 'Передний бампер')",
  "type": "STRING (Тип: 'Вмятина', 'Царапина', 'Скол', 'Трещина', 'Потертость', 'Ржавчина')",
  "location": "STRING (Точное место, e.g., 'центр двери', 'нижний угол')",
  "description": "STRING (Детальное описание: размер, глубина, характер)",
  "confidence": INTEGER (0-100),
  "segmentation_polygon": [
    { "x": FLOAT (0-100), "y": FLOAT (0-100) }, // Points must be percentages of image width/height
    ...
  ]
}`;

        // 4. Process each photo
        for (const [angle, base64Image] of Object.entries(photos)) {
            if (!base64Image) continue;

            const pureBase64 = base64Image.split(',')[1];

            // 5. Construct payload for Gemini API
            const payload = {
                contents: [{
                    parts: [
                        { text: finalPrompt },
                        { inline_data: { mime_type: "image/jpeg", data: pureBase64 } }
                    ]
                }],
                generationConfig: {
                    "response_mime_type": "application/json",
                }
            };

            // 6. Call the Gemini API
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.error(`API Error for ${angle}: ${response.status}`, errorBody);
                finalResults[angle] = [];
                continue;
            }

            const result = await response.json();

            if (!result.candidates || result.candidates.length === 0) {
                 finalResults[angle] = [];
                 continue;
            }

            if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts[0].text) {
                const text = result.candidates[0].content.parts[0].text;
                try {
                    const damages = JSON.parse(text);
                    finalResults[angle] = [];
                    damages.forEach(damage => {
                        // Filter by confidence
                        if (damage.confidence >= minConfidence) {
                            damage.id = totalDamageCounter++;
                            finalResults[angle].push(damage);
                        }
                    });
                } catch (e) {
                    console.error(`JSON Parsing Error for ${angle}:`, e);
                    finalResults[angle] = [];
                }
            } else {
                finalResults[angle] = [];
            }
        }

        return res.status(200).json(finalResults);

    } catch (error) {
        console.error('Error in analyze controller:', error);
        return res.status(500).json({
            error: error.message
        });
    }
};
