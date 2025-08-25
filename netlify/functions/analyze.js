// Note: 'node-fetch' is a dependency that needs to be installed.
const fetch = require('node-fetch');

exports.handler = async (event) => {
  // 1. Check for POST request
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 2. Extract data and API key
    const { photos, prompt } = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error('GEMINI_API_KEY is not set in environment variables.');
      return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
    }

    if (!photos || Object.keys(photos).length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No photos provided for analysis.' })};
    }

    // 3. Define API details
    const model = 'gemini-1.5-flash-latest';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const finalResults = {};
    let totalDamageCounter = 1;

    if (!prompt) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No prompt provided.' })};
    }

    // 4. Process each photo
    for (const [angle, base64Image] of Object.entries(photos)) {
        if (!base64Image) continue;

        const pureBase64 = base64Image.split(',')[1];

        // 5. Construct payload for Gemini API
        const payload = {
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: "image/jpeg", data: pureBase64 } }
                ]
            }],
            generationConfig: {
                responseMimeType: "application/json",
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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Allow requests from any origin
      },
      body: JSON.stringify(finalResults),
    };
  } catch (error) {
    console.error('Error in Netlify function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
