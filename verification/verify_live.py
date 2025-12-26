from playwright.sync_api import sync_playwright

def verify_live_inspection_page():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Navigate to the live inspection page
        page.goto("http://localhost:3000/live.html")

        # Check if the title is correct or key elements are present
        # Note: We cannot fully test the WebSocket/Camera interaction without real devices/backend
        # but we can verify the UI structure loaded from the updated js.

        # Check for start button
        start_btn = page.get_by_text("Начать осмотр")
        if start_btn.is_visible():
            print("Start button is visible")

        # Check for status indicator
        status_indicator = page.locator("#status-indicator")
        if status_indicator.is_visible():
             print(f"Status indicator visible with text: {status_indicator.inner_text()}")

        # Take a screenshot
        page.screenshot(path="verification/live_page.png")
        browser.close()

if __name__ == "__main__":
    verify_live_inspection_page()
