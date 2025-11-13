const { test, expect, devices } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const BASE_URL = `http://localhost:${PORT}`;

// Mock Netlify functions
const mockUploadVideo = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobId: 'mock-job-id' }));
};

const mockCheckStatus = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'complete', analysis: { damages: [] } }));
};

const server = http.createServer((req, res) => {
    if (req.url === '/.netlify/functions/upload-video' && req.method === 'POST') {
        return mockUploadVideo(req, res);
    }
    if (req.url.startsWith('/.netlify/functions/check-status') && req.method === 'GET') {
        return mockCheckStatus(req, res);
    }

    const filePath = path.join(__dirname, '..', req.url === '/' ? 'video.html' : req.url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
    };
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end(`File not found: ${req.url}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content, 'utf-8');
    });
});

test.beforeAll(() => {
    server.listen(PORT);
});

test.afterAll(() => {
    server.close();
});

test.describe('Mobile Video Recording Flow', () => {
    test('should complete the full video recording process on an iPhone 11', async ({ browser }) => {
        const iPhone = devices['iPhone 11'];
        const context = await browser.newContext({
            ...iPhone,
            permissions: ['camera'],
            launchOptions: {
                args: [
                    '--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream',
                ],
            },
        });
        const page = await context.newPage();

        // Capture console logs for debugging
        page.on('console', msg => console.log(`Browser Console: ${msg.text()}`));

        await page.goto(BASE_URL);

        // Start the process
        await page.click('#start-recording-btn');
        await expect(page.locator('#screen-user-video')).toBeVisible({ timeout: 10000 });

        // Check if the recorder was created. If not, the test environment has no camera.
        const isRecorderAvailable = await page.evaluate(() => !!window.testing.a_userMediaRecorder);
        if (!isRecorderAvailable) {
            console.warn('MediaRecorder not available in test environment. Skipping recorder interaction tests.');
            test.skip();
            return;
        }

        // Since we can't rely on the fake media stream timer, we'll manually trigger the stop event.
        await page.evaluate(() => window.testing.a_userMediaRecorder.stop());

        // Wait for the car recording screen to become visible
        await expect(page.locator('#screen-recording')).toBeVisible({ timeout: 10000 });

        // Manually trigger the dataavailable and stop events for the car recorder
        await page.evaluate(() => {
            const fakeBlob = new Blob(['fake video data'], { type: 'video/mp4' });
            window.testing.a_carMediaRecorder.dispatchEvent(new BlobEvent('dataavailable', { data: fakeBlob }));
            window.testing.a_carMediaRecorder.dispatchEvent(new Event('stop'));
        });

        // Check that processing starts
        await expect(page.locator('#screen-processing')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('#processing-status')).toHaveText(/Загрузка видео на сервер...|Обработка видео и извлечение кадров.../, { timeout: 10000 });

        // Wait for mocked results to be displayed
        await expect(page.locator('#screen-results')).toBeVisible({ timeout: 20000 });
        await expect(page.locator('#results-summary')).toHaveText('Повреждений не найдено.', { timeout: 10000 });

        await context.close();
    });
});
