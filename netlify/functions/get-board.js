const fs = require('fs/promises');
const path = require('path');

// Helper function to read data from JSON files
const readData = async (fileName) => {
    const filePath = path.join(__dirname, 'data', fileName);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
};

exports.handler = async (event) => {
    // 1. Check for GET request
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // 2. Get boardId and userId from query parameters
        const { boardId, userId } = event.queryStringParameters;

        if (!boardId || !userId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'boardId and userId are required query parameters.' }) };
        }

        // 3. Read all necessary data
        const boards = await readData('boards.json');
        const boardMembers = await readData('board_members.json');

        // 4. Find the requested board
        const board = boards.find(b => b.id === boardId);
        if (!board) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Board not found.' }) };
        }

        // 5. Check for user membership
        const isMember = boardMembers.some(m => m.boardId === boardId && m.userId === userId);
        if (!isMember) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You are not a member of this board.' }) };
        }

        // 6. If user is a member, find their role and also get all tasks for the board
        const memberInfo = boardMembers.find(m => m.boardId === boardId && m.userId === userId);
        const allTasks = await readData('tasks.json');
        const boardTasks = allTasks.filter(t => t.boardId === boardId);

        // 7. Return the board data, tasks, and the user's role
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
                ...board,
                tasks: boardTasks,
                userRole: memberInfo.role,
            }),
        };

    } catch (error) {
        console.error('Error in get-board function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' }),
        };
    }
};
