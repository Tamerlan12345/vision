const { chromium } = require('playwright');
const path = require('path');

(async () => {
    // We need to launch with options to mock camera/microphone
    const browser = await chromium.launch({
        headless: true, // headless must be true for verification instruction
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
        ]
    });
    const context = await browser.newContext({
        permissions: ['camera', 'microphone']
    });
    const page = await context.newPage();

    console.log("Navigating to Live Inspection page...");
    await page.goto('http://localhost:3000/live.html');

    // Wait for the start button
    await page.waitForSelector('#start-btn');
    console.log("Start button found.");

    // Click Start
    await page.click('#start-btn');
    console.log("Clicked Start.");

    // The "Status" should change to "Connecting..." or "Listening"
    // Since we don't have a real Gemini backend connected with key, it might error out or get stuck at "Connecting" or fail.
    // However, the test is to verify the UI *can* be interacted with and the Stop button logic *can* be triggered.
    // If the websocket connection fails immediately (no key), we might see an error.

    // Let's see what happens.
    // We wait a bit.
    await page.waitForTimeout(2000);

    // Take a screenshot of the active state
    await page.screenshot({ path: 'verification/live_active.png' });
    console.log("Active state screenshot taken.");

    // Check if Stop button is enabled.
    const stopBtn = await page.$('#stop-btn');
    const isEnabled = await stopBtn.isEnabled();
    console.log(`Stop button enabled: ${isEnabled}`);

    if (isEnabled) {
        // Click Stop
        await page.click('#stop-btn');
        console.log("Clicked Stop.");

        // Verify button becomes disabled immediately (Frontend logic check)
        const isDisabledAfter = await stopBtn.isDisabled();
        console.log(`Stop button disabled after click: ${isDisabledAfter}`);

        if (!isDisabledAfter) {
            console.error("FAILURE: Stop button was not disabled immediately.");
        }

        // Take a screenshot of the stopped state
        await page.screenshot({ path: 'verification/live_stopped.png' });
    } else {
        console.log("Stop button was not enabled (likely connection failed due to missing API key), which is expected in this env without key.");
        // Take a screenshot of the error state
        await page.screenshot({ path: 'verification/live_error.png' });
    }

    await browser.close();
})();
