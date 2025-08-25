const fs = require('fs/promises');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const boardsFilePath = path.join(dataDir, 'boards.json');
const membersFilePath = path.join(dataDir, 'board_members.json');

// Helper to read data
const readData = async (filePath) => {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
};

// Helper to write data
const writeData = async (filePath, data) => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { boardId, userId, payload } = JSON.parse(event.body);

        if (!boardId || !userId || !payload) {
            return { statusCode: 400, body: JSON.stringify({ error: 'boardId, userId, and payload are required.' }) };
        }

        // 1. Read data
        const allBoards = await readData(boardsFilePath);
        const allMembers = await readData(membersFilePath);

        // 2. Authorization: Check if the user is a Board Admin for this board
        const memberInfo = allMembers.find(m => m.boardId === boardId && m.userId === userId);
        if (!memberInfo || memberInfo.role !== 'Board Admin') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You must be an admin to edit this board.' }) };
        }

        // 3. Find the board to edit
        let boardToEdit = allBoards.find(b => b.id === boardId);
        if (!boardToEdit) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Board not found.' }) };
        }

        // 4. Apply changes from payload
        // Can update board name and columns
        if (payload.name) {
            boardToEdit.name = payload.name;
        }
        if (payload.columns && Array.isArray(payload.columns)) {
            // Simple replacement for now. More complex logic could merge changes.
            boardToEdit.columns = payload.columns;
        }

        // 5. Update the boards array
        const updatedBoards = allBoards.map(b => b.id === boardId ? boardToEdit : b);

        // 6. Write the changes back to the file
        await writeData(boardsFilePath, updatedBoards);

        // 7. Return the updated board
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(boardToEdit),
        };

    } catch (error) {
        console.error('Error in edit-board function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' }),
        };
    }
};
