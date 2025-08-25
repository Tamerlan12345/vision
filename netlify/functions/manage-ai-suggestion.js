const fs = require('fs/promises');
const path = require('path');

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
        const { suggestionId, userId, action } = JSON.parse(event.body); // action: 'approve' or 'reject'

        if (!suggestionId || !userId || !action || !['approve', 'reject'].includes(action)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'suggestionId, userId, and a valid action are required.' }) };
        }

        // 1. Read all data
        const allSuggestions = await readData('ai_suggestions.json');
        const allTasks = await readData('tasks.json');
        const allMembers = await readData('board_members.json');
        const allPersonalTasks = await readData('personal_tasks.json');

        // 2. Find suggestion and related task
        const suggestion = allSuggestions.find(s => s.id === suggestionId);
        if (!suggestion) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Suggestion not found.' }) };
        }
        if (suggestion.status !== 'pending') {
            return { statusCode: 400, body: JSON.stringify({ error: `Suggestion has already been ${suggestion.status}.` }) };
        }
        const task = allTasks.find(t => t.id === suggestion.taskId);
        if (!task) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Associated task not found.' }) };
        }

        // 3. Authorization: User must be a Board Admin
        const memberInfo = allMembers.find(m => m.boardId === task.boardId && m.userId === userId);
        if (!memberInfo || memberInfo.role !== 'Board Admin') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: You must be an admin to manage suggestions.' }) };
        }

        // 4. Perform action
        if (action === 'reject') {
            suggestion.status = 'rejected';
            await writeData('ai_suggestions.json', allSuggestions);
            return { statusCode: 200, body: JSON.stringify({ message: 'Suggestion rejected.' }) };
        }

        if (action === 'approve') {
            if (!task.assigneeId) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Cannot approve suggestion for a task with no assignee.' }) };
            }

            suggestion.status = 'approved';

            // Create new personal tasks from the suggestion
            const newPersonalTasks = suggestion.suggestedSubtasks.map(subtask => ({
                id: `ptask-${new Date().getTime()}-${Math.random()}`,
                projectTaskId: task.id,
                userId: task.assigneeId,
                title: subtask.title,
                completed: false,
                createdAt: new Date().toISOString(),
            }));

            const updatedPersonalTasks = [...allPersonalTasks, ...newPersonalTasks];

            // Write all changes
            await writeData('ai_suggestions.json', allSuggestions);
            await writeData('personal_tasks.json', updatedPersonalTasks);

            return { statusCode: 200, body: JSON.stringify({ message: 'Suggestion approved and personal tasks created.', createdTasks: newPersonalTasks }) };
        }

    } catch (error) {
        console.error('Error in manage-ai-suggestion function:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'An internal server error occurred.' }) };
    }
};
