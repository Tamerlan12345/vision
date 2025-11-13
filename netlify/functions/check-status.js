
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const jobId = event.queryStringParameters.jobId;
    if (!jobId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'jobId is required.' }) };
    }

    try {
        connectLambda(event);
        const statusStore = getStore('statuses');
        const status = await statusStore.get(jobId, { type: 'json' });

        if (!status) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Job not found.' }) };
        }

        if (status.status === 'complete') {
            const resultStore = getStore('results');
            const result = await resultStore.get(jobId, { type: 'json' });
            return {
                statusCode: 200,
                body: JSON.stringify(result),
            };
        }

        // For 'pending', 'processing', or 'error' statuses
        return {
            statusCode: 200, // Still 200, but the body indicates the status
            body: JSON.stringify(status),
        };

    } catch (error) {
        console.error(`Error checking status for job ${jobId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to check job status.', details: error.message }),
        };
    }
};
