from playwright.sync_api import sync_playwright, Page, expect

def verify_inspection_status(page: Page):
    # Navigate to the live inspection page
    page.goto("http://localhost:3000/live.html")

    # Verify initial state
    expect(page.locator("#status-indicator")).to_have_text("Статус: Ожидание")

    # Need to simulate "Start" click, but it requires media permissions which might be tricky in headless.
    # We can try to mock getUserMedia or just trigger the start logic manually if permissions are an issue.
    # Playwright has context options for permissions.

    # However, connection to Gemini requires API key which I don't have.
    # So the socket connection will close immediately or fail.

    # 1. Click Start
    # Permissions for camera/microphone
    context = page.context
    context.grant_permissions(['camera', 'microphone'])

    page.click("#start-btn")

    # Verify "Connecting..."
    expect(page.locator("#status-indicator")).to_have_text("Статус: Подключение к ИИ...")

    # Take screenshot of connecting state
    page.screenshot(path="verification/connecting.png")

    # Now, since we don't have a real API key in this environment (likely),
    # the server should close the connection or return error.
    # My server.js change sends { type: 'error', message: 'Server API Key missing' } if key is missing.
    # Or if key is invalid, Gemini closes connection.

    # Let's wait a bit to see what happens.
    # We expect "Status: Error..." or similar.

    try:
        # Wait for error text or status change
        page.wait_for_timeout(2000)
        page.screenshot(path="verification/after_connect_attempt.png")
    except:
        pass

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        context = browser.new_context()
        page = context.new_page()
        try:
            verify_inspection_status(page)
        finally:
            browser.close()
