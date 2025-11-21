const fetch = require('node-fetch');

exports.handle = async (req, res) => {
    try {
        const { photos } = req.body;
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

        const finalPrompt = `You are a world-class automotive damage assessment expert. Your task is to conduct a meticulous analysis of the provided car image. You must identify ALL defects, from major impacts to minor flaws like swirl marks or rock chips. For each identified defect, you must provide a detailed, structured report.
Chain of Thought:

Initial Scan: Quickly scan the entire image to understand the context, lighting, and angle. Note any areas obscured by shadows, reflections, or dirt.
Systematic Decomposition: Mentally divide the vehicle into standard parts (e.g., front bumper, hood, left front fender, left front door, etc.).
Sequential Analysis: Examine each part methodically, as if using a magnifying glass.
Defect Identification & Segmentation: For each defect, precisely outline its boundary with a polygon. Do NOT use simple boxes. The polygon must be tight and accurate.
Detailed Classification & Description: Classify the defect and provide a rich, detailed description.
Critical Review: Re-evaluate every identified defect. Is it truly damage or just a reflection? Is the polygon accurate? Is the description clear? Discard any findings you are not confident about.
Report Generation: Only after this rigorous process, compile the final JSON array.
STRICT OUTPUT REQUIREMENTS:

Your response MUST be ONLY a JSON array. Do not add any text, comments, or markdown before or after the array. If no damage is found, return an empty array \`[]\`.
**All user-facing strings (like 'part', 'type', 'location', 'description', and 'notes') MUST be in Russian.**

Each object in the array must have the following structure: { "part": "STRING", // Название детали НА РУССКОМ (e.g., "Передний бампер", "Капот"). "type": "STRING", // Тип повреждения НА РУССКОМ ("Вмятина", "Царапина", "Скол", "Трещина", "Потертость", "Ржавчина", "Другое"). "location": "STRING", // Краткое описание местоположения на детали НА РУССКОМ (e.g., "верхний правый угол", "центр, возле фары"). "description": "STRING", // ПОДРОБНОЕ, экспертное описание повреждения НА РУССКОМ. Для царапины укажите длину и глубину. Для вмятины - размер и форму. "confidence": "INTEGER", // Your confidence level (0-100). If < 95, explain why in the 'notes'. "notes": "STRING", // Необязательно: укажите неточности НА РУССКОМ (e.g., "Плохое освещение в этой области мешает точной оценке.", "Может быть отражением, но, похоже, имеет глубину."). "segmentation_polygon": [ { "x": "FLOAT", "y": "FLOAT" }, // An array of {x, y} points outlining the damage. Values must be percentages of the image dimensions (0.0 to 100.0). ... ] }`;

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
                // Don't throw, just record an empty result for this angle
                finalResults[angle] = [];
                continue; // Move to the next image
            }

            const result = await response.json();

            // Error handling for blocked content
            if (!result.candidates || result.candidates.length === 0) {
                 console.warn(`Response from API for ${angle} was blocked or empty.`, result.promptFeedback);
                 finalResults[angle] = [];
                 continue;
            }

            if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts[0].text) {
                const text = result.candidates[0].content.parts[0].text;
                try {
                    const damages = JSON.parse(text);
                    finalResults[angle] = [];
                    damages.forEach(damage => {
                        damage.id = totalDamageCounter++;
                        finalResults[angle].push(damage);
                    });
                } catch (e) {
                    console.error(`JSON Parsing Error for ${angle}:`, e, "Received text:", text);
                    finalResults[angle] = []; // Assign empty array on parsing error
                }
            } else {
                console.warn(`No valid candidates in response for ${angle}`, result);
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
