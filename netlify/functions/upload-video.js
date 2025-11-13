
const { getStore, connectLambda } = require('@netlify/blobs');
const fetch = require('node-fetch');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        connectLambda(event);
        // Dynamically import uuid
        const { v4: uuidv4 } = await import('uuid');

        const { video: videoBase64 } = JSON.parse(event.body);
        if (!videoBase64) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No video data provided.' }) };
        }

        const jobId = uuidv4();
        const videoStore = getStore('videos');

        // The video data is a Base64 string, which is what set() expects.
        await videoStore.set(jobId, videoBase64);

        // Set initial status
        const statusStore = getStore('statuses');
        await statusStore.setJSON(jobId, { status: 'pending', timestamp: new Date().toISOString() });


        // Invoke the background function to process the video
        // Note: We are not awaiting this.
        fetch(`${process.env.URL}/.netlify/functions/process-video-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
        });

        console.log(`Job started: ${jobId}`);

        return {
            statusCode: 202, // Accepted
            body: JSON.stringify({ jobId }),
        };
    } catch (error) {
        console.error('Error in upload-video function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to start video processing job.', details: error.message }),
        };
    }
};
