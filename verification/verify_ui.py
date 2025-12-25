from playwright.sync_api import sync_playwright

def verify_live_inspection_ui():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream"
            ]
        )
        context = browser.new_context(permissions=['camera', 'microphone'])
        page = context.new_page()

        # 1. Navigate to Home
        print("Navigating to index.html...")
        page.goto("http://localhost:3000/index.html")
        page.screenshot(path="verification/step1_home.png")

        # 2. Click "Interactive Inspection"
        print("Clicking Interactive Inspection...")
        page.click("text=Начать Интерактивный Осмотр (NEW)")

        # 3. Verify Live Page
        print("Verifying Live Page...")
        page.wait_for_selector("#video-preview")
        page.wait_for_selector("#status-indicator")

        # Take screenshot of the initial state
        page.screenshot(path="verification/step2_live_initial.png")

        # 4. Click Start Inspection (simulate)
        print("Clicking Start...")
        # Note: This might fail if WS cannot connect to real Gemini API without key or if key is invalid,
        # but we just want to verify UI transition.
        # The code waits for WS open to update status.
        # If WS fails, we might see error.

        try:
            page.click("#start-btn")
            # Wait a bit to see if status changes or error appears
            page.wait_for_timeout(2000)
            page.screenshot(path="verification/step3_live_started.png")
        except Exception as e:
            print(f"Error interacting: {e}")

        browser.close()

if __name__ == "__main__":
    verify_live_inspection_ui()
