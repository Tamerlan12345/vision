// Note: 'node-fetch' is a dependency that needs to be installed. const fetch = require('node-fetch');

exports.handler = async (event) => { // 1. Check for POST request if (event.httpMethod !== 'POST') { return { statusCode: 405, body: 'Method Not Allowed' }; }

try { // 2. Extract data and API key const { photos, prompt } = JSON.parse(event.body); const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('GEMINI_API_KEY is not set in environment variables.');
  return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
}

if (!photos || Object.keys(photos).length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No photos provided for analysis.' })};
}

// 3. Define API details
const model = 'gemini-1.5-flash-latest'; // <<<< UPDATED MODEL
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const finalResults = {};
let totalDamageCounter = 1;

const finalPrompt = prompt || `You are a world-class automotive damage assessment expert. Your task is to conduct a meticulous analysis of the provided car image. You must identify ALL defects, from major impacts to minor flaws like swirl marks or rock chips. For each identified defect, you must provide a detailed, structured report.
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

Each object in the array must have the following structure: { "part": "STRING", // The specific car part (e.g., "Front Bumper", "Hood", "Left Front Door"). Be precise. "type": "STRING", // MUST be one of: "Dent", "Scratch", "Chip", "Crack", "Scuff", "Rust", "Other". "location": "STRING", // A brief description of the location ON THE PART (e.g., "upper right corner", "center, near the headlight", "along the bottom edge"). "description": "STRING", // A DETAILED, expert description of the damage. For a scratch, specify length and depth (e.g., "Deep scratch, approx. 15cm long, appears to have penetrated the clear coat."). For a dent, describe its size and shape (e.g., "Shallow, round dent, approx. 5cm in diameter."). "confidence": "INTEGER", // Your confidence level (0-100). If < 95, explain why in the 'notes'. "notes": "STRING", // Optional: Mention any uncertainties (e.g., "Poor lighting in this area makes it hard to be certain.", "Could be a reflection, but appears to have depth."). "segmentation_polygon": [ { "x": "FLOAT", "y": "FLOAT" }, // An array of {x, y} points outlining the damage. Values must be percentages of the image dimensions (0.0 to 100.0). ... ] }`;

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

return {
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // Allow requests from any origin
  },
  body: JSON.stringify(finalResults),
};
} catch (error) { console.error('Error in Netlify function:', error); return { statusCode: 500, body: JSON.stringify({ error: error.message }), }; } };
