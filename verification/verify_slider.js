const { chromium } = require('playwright');
const path = require('path');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Serve the file directly if possible, or assume server is running on 3000
    // The instructions say "npm start" serves on 3000.
    // I will try to access via file protocol first as it's static html, but it might need server for relative paths.
    // Given the previous instructions, I should probably rely on the server.
    // But I haven't started the server yet. I will start it in the next step.
    // For now I'll write the script assuming localhost:3000.

    await page.goto('http://localhost:3000/index.html');

    // Check if slider exists
    const slider = page.locator('#confidence-threshold');
    await slider.waitFor({ state: 'visible' });

    // Check default value
    const valueDisplay = page.locator('#confidence-value');
    const initialValue = await valueDisplay.innerText();
    console.log('Initial value:', initialValue);

    // Change slider value
    await slider.fill('90');
    // Trigger input event if fill doesn't (fill usually does for text, for range it might need evaluation)
    await page.evaluate(() => {
        const input = document.querySelector('#confidence-threshold');
        input.value = 90;
        input.dispatchEvent(new Event('input'));
    });

    const newValue = await valueDisplay.innerText();
    console.log('New value:', newValue);

    // Take screenshot
    await page.screenshot({ path: 'verification/slider_verification.png' });

    await browser.close();
})();
