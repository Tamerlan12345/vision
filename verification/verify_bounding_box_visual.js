const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    // We need to inject the function into a page to test it visually,
    // as we can't easily mock the whole app flow with backend in this restricted environment without a real photo.
    // However, I can create a simple test page that uses the modified 'drawOnCanvas' function.

    // 1. Load the real index.html to get the function definition
    await page.goto('http://localhost:3000/index.html');

    // 2. Inject a test canvas and run drawOnCanvas with mock data
    await page.evaluate(() => {
        // Create a test container overlay
        const container = document.createElement('div');
        container.style.position = 'fixed';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100vw';
        container.style.height = '100vh';
        container.style.backgroundColor = 'white';
        container.style.zIndex = '9999';
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.justifyContent = 'center';
        document.body.appendChild(container);

        const canvas = document.createElement('canvas');
        canvas.id = 'test-canvas';
        container.appendChild(canvas);

        // Mock data
        const mockDamage = {
            id: 1,
            type: 'Вмятина',
            confidence: 90,
            segmentation_polygon: [
                {x: 20, y: 20},
                {x: 40, y: 20},
                {x: 40, y: 40},
                {x: 30, y: 50},
                {x: 20, y: 40}
            ]
        };

        // Mock image (using a colored rect as placeholder)
        // We need to override the Image loading part of drawOnCanvas for this test
        // OR provide a data URL of a simple image.

        // Create a simple 100x100 green image
        const imgCanvas = document.createElement('canvas');
        imgCanvas.width = 100;
        imgCanvas.height = 100;
        const imgCtx = imgCanvas.getContext('2d');
        imgCtx.fillStyle = '#eee';
        imgCtx.fillRect(0,0,100,100);
        const imgUrl = imgCanvas.toDataURL();

        // Call the function
        // Note: drawOnCanvas is defined in the script in index.html, it should be available in global scope
        // IF it was attached to window or defined globally.
        // Looking at index.html, it is inside 'DOMContentLoaded', so it is NOT global.
        // I need to extract the function logic or modify index.html to expose it.
        // BUT I already exposed it in the previous step!
        // "window.displayResults = displayResults;" - wait, did I expose drawOnCanvas?
        // I checked my previous index.html content... I exposed appState, showScreen, displayResults.
        // drawOnCanvas is called by displayResults.

        // I can try to use displayResults, but that requires more setup.
        // Alternatively, I can redefine drawOnCanvas here for the test using the code I know is there.
        // But that defeats the purpose of verifying the *actual* code.

        // Let's check if I can access the internal function via the exposed displayResults? No.

        // Wait, I can just modify the appState and trigger displayResults?
        // appState is exposed. displayResults is exposed.

        // Let's try to simulate the result display.
        const mockResults = {
            'front': [mockDamage]
        };

        window.appState.mode = 'multi';
        window.appState.photos['front'] = imgUrl;

        // We need to make sure the elements exist for displayResults to work
        // It targets 'results-container'.
        // I'll clear the container first.
        const resultsContainer = document.getElementById('results-container');
        resultsContainer.innerHTML = '';

        // Call displayResults
        window.displayResults(mockResults);
    });

    // Wait for canvas to be drawn (image loading takes a tick)
    await page.waitForTimeout(1000);

    await page.screenshot({ path: 'verification/bounding_box_visual.png' });
    await browser.close();
})();
