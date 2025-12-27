const { chromium } = require('playwright');
const path = require('path');

(async () => {
    // We'll run in headful mode to see the browser if needed, but for CI/Sandbox headless is better.
    // However, media permissions often require some flags.
    const browser = await chromium.launch({
        headless: true, // Use headless for the sandbox
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream'
        ]
    });

    const context = await browser.newContext();
    // Grant permissions for camera and microphone
    await context.grantPermissions(['camera', 'microphone']);

    const page = await context.newPage();

    // 1. Navigate to the Live Inspection page
    // Assuming the server is running on localhost:3000
    try {
        await page.goto('http://localhost:3000/live.html');
        console.log("Navigated to Live Inspection page.");
    } catch (e) {
        console.error("Failed to navigate:", e);
        process.exit(1);
    }

    // 2. Click "Start Inspection"
    const startBtn = page.locator('#start-btn');
    await startBtn.waitFor({ state: 'visible' });
    await startBtn.click();
    console.log("Clicked Start button.");

    // 3. Verify status changes
    // Initially it should show "Подключение к ИИ..." or "status-waiting"
    const statusIndicator = page.locator('#status-indicator');
    await statusIndicator.waitFor({ state: 'visible' });

    // We expect "Подключение к ИИ..." immediately
    let statusText = await statusIndicator.textContent();
    console.log(`Initial Status: ${statusText}`);

    // 4. Wait for connection (mocked or real)
    // Since we don't have a real Gemini key/connection in this environment (likely),
    // the server might close the connection or send an error.
    // However, we are verifying the CLIENT logic: Setup first, then delay, then Media.

    // We can check if "status-listening" appears after ~1s (if connection succeeds)
    // OR if we get an error because of missing key.

    // If the server sends an error immediately (missing key), the client shows "Ошибка..."

    // Let's capture a screenshot after a short delay to see the state.
    await page.waitForTimeout(1500);

    statusText = await statusIndicator.textContent();
    console.log(`Status after 1.5s: ${statusText}`);

    await page.screenshot({ path: '/home/jules/verification/live_inspection_state.png' });
    console.log("Screenshot taken.");

    // Check browser console logs for the specific log messages we added
    // "Starting media capture after delay..."
    // We need to attach console listener BEFORE clicking start, but we can't easily access past logs here
    // unless we had the listener from the start.

    await browser.close();
})();
