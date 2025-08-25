const fs = require('fs/promises');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const readData = async (fileName) => {
    const filePath = path.join(dataDir, fileName);
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { boardId, userId } = event.queryStringParameters;

        if (!boardId || !userId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'boardId and userId are required.' }) };
        }

        // 1. Authorization: User must be a Board Admin
        const allMembers = await readData('board_members.json');
        const memberInfo = allMembers.find(m => m.boardId === boardId && m.userId === userId);
        if (!memberInfo || memberInfo.role !== 'Board Admin') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You must be an admin to view analytics.' }) };
        }

        // 2. Read data sources
        const allTasks = await readData('tasks.json');
        const allEvents = await readData('events.json');
        const allSuggestions = await readData('ai_suggestions.json');

        // 3. Filter data for the current board
        const boardTasks = allTasks.filter(t => t.boardId === boardId);
        const boardTaskIds = new Set(boardTasks.map(t => t.id));
        const boardEvents = allEvents.filter(e => e.details && e.details.boardId === boardId);
        const boardSuggestions = allSuggestions.filter(s => boardTaskIds.has(s.taskId));

        // 4. Calculate metrics
        const oneDayAgo = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));
        const tasksCreatedLast24h = boardEvents.filter(e =>
            e.type === 'TASK_CREATED' && new Date(e.timestamp) > oneDayAgo
        ).length;

        const metrics = {
            total_tasks: boardTasks.length,
            throughput_last_24h: tasksCreatedLast24h, // Simple throughput metric
            decomposition_requests: boardSuggestions.length,
            ai_heavy_tasks_percent: boardTasks.length > 0 ? (boardSuggestions.length / boardTasks.length) * 100 : 0,
        };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(metrics),
        };

    } catch (error) {
        console.error('Error in get-analytics function:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'An internal server error occurred.' }) };
    }
};
