const fs = require('fs/promises');
const path = require('path');
const fetch = require('node-fetch');

const dataDir = path.join(__dirname, 'data');
const readData = async (fileName) => {
    const filePath = path.join(dataDir, fileName);
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
};
const writeData = async (fileName, data) => {
    const filePath = path.join(dataDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { taskId, userId } = JSON.parse(event.body);
        const apiKey = process.env.GEMINI_API_KEY;

        if (!taskId || !userId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'taskId and userId are required.' }) };
        }
        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: API key is missing.' }) };
        }

        // 1. Get task details
        const allTasks = await readData('tasks.json');
        const task = allTasks.find(t => t.id === taskId);
        if (!task) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Task not found.' }) };
        }

        // 2. Authorization: User must be a member of the board
        const allMembers = await readData('board_members.json');
        const isMember = allMembers.some(m => m.boardId === task.boardId && m.userId === userId);
        if (!isMember) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You are not a member of this board.' }) };
        }

        // 3. Construct Prompt for Gemini
        const prompt = `You are an expert project manager. Decompose the following task into a list of actionable sub-tasks.
Task Title: "${task.title}"
Task Description: "${task.description}"
Provide the output as a simple JSON array of strings. Example: ["Sub-task 1", "Sub-task 2", "Sub-task 3"]`;

        const model = 'gemini-1.5-flash-latest';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
        };

        // 4. Call Gemini API
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`API Error for task ${taskId}: ${response.status}`, errorBody);
            return { statusCode: 502, body: JSON.stringify({ error: 'Failed to get decomposition from AI service.'}) };
        }

        const result = await response.json();
        const subtaskTitles = JSON.parse(result.candidates[0].content.parts[0].text);

        // 5. Create and save suggestion
        const allSuggestions = await readData('ai_suggestions.json');
        const newSuggestion = {
            id: `sugg-${new Date().getTime()}`,
            taskId,
            status: 'pending',
            suggestedSubtasks: subtaskTitles.map(title => ({ title, completed: false })),
            requestedBy: userId,
            createdAt: new Date().toISOString(),
        };

        allSuggestions.push(newSuggestion);
        await writeData('ai_suggestions.json', allSuggestions);

        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(newSuggestion),
        };

    } catch (error) {
        console.error('Error in request-ai-decomposition function:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'An internal server error occurred.' }) };
    }
};
