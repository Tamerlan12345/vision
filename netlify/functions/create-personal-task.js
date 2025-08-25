const fs = require('fs/promises');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const personalTasksFilePath = path.join(dataDir, 'personal_tasks.json');
const tasksFilePath = path.join(dataDir, 'tasks.json');

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
        const { projectTaskId, userId, title } = JSON.parse(event.body);

        if (!projectTaskId || !userId || !title) {
            return { statusCode: 400, body: JSON.stringify({ error: 'projectTaskId, userId, and title are required.' }) };
        }

        // Authorization: User must be the assignee of the project task to create a sub-task.
        const allTasks = await readData(tasksFilePath);
        const projectTask = allTasks.find(t => t.id === projectTaskId);

        if (!projectTask) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Project task not found.' }) };
        }

        if (projectTask.assigneeId !== userId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You can only create sub-tasks for tasks assigned to you.' }) };
        }

        const allPersonalTasks = await readData(personalTasksFilePath);

        const newPersonalTask = {
            id: `ptask-${new Date().getTime()}`,
            projectTaskId,
            userId,
            title,
            completed: false,
            createdAt: new Date().toISOString(),
        };

        allPersonalTasks.push(newPersonalTask);
        await writeData(personalTasksFilePath, allPersonalTasks);

        return {
            statusCode: 201,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify(newPersonalTask),
        };

    } catch (error) {
        console.error('Error in create-personal-task function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' }),
        };
    }
};
