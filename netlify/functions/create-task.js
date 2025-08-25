const fs = require('fs/promises');
const path =require('path');

const dataDir = path.join(__dirname, 'data');
const tasksFilePath = path.join(dataDir, 'tasks.json');
const membersFilePath = path.join(dataDir, 'board_members.json');

const readData = async (filePath) => {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
};

const writeData = async (filePath, data) => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { boardId, columnId, title, description, assigneeId, creatorId } = JSON.parse(event.body);

        if (!boardId || !columnId || !title || !creatorId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'boardId, columnId, title, and creatorId are required.' }) };
        }

        // Authorization: Only a Board Admin can create tasks on the main board.
        const allMembers = await readData(membersFilePath);
        const memberInfo = allMembers.find(m => m.boardId === boardId && m.userId === creatorId);
        if (!memberInfo || memberInfo.role !== 'Board Admin') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You must be an admin to create tasks on this board.' }) };
        }

        const allTasks = await readData(tasksFilePath);

        const newTask = {
            id: `task-${new Date().getTime()}`, // Simple unique ID
            boardId,
            columnId,
            title,
            description: description || '',
            assigneeId: assigneeId || null,
            epicId: null,
            sprintId: null,
            createdAt: new Date().toISOString(),
        };

        allTasks.push(newTask);

        // Log the event
        const allEvents = await readData(path.join(dataDir, 'events.json'));
        const newEvent = {
            type: 'TASK_CREATED',
            timestamp: new Date().toISOString(),
            details: {
                taskId: newTask.id,
                boardId: boardId,
                creatorId: creatorId,
            }
        };
        allEvents.push(newEvent);

        // Write both files
        await writeData(tasksFilePath, allTasks);
        await writeData(path.join(dataDir, 'events.json'), allEvents);

        return {
            statusCode: 201, // 201 Created
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(newTask),
        };

    } catch (error) {
        console.error('Error in create-task function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' }),
        };
    }
};
