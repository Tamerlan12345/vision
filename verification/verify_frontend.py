from playwright.sync_api import sync_playwright, expect
import time

def verify_homepage():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Navigate to the homepage
        page.goto("http://localhost:3000")

        # Check if the title is correct
        expect(page).to_have_title("Осмотр ТС - Сентрас Иншуранс")

        # Check if the main elements are visible
        expect(page.locator("h1")).to_have_text("Осмотр Транспортного Средства")

        # Take a screenshot of the homepage
        page.screenshot(path="verification/homepage.png")

        browser.close()

def verify_video_page():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Navigate to the video page
        page.goto("http://localhost:3000/video.html")

        # Check if the title is correct
        expect(page).to_have_title("Видео-осмотр - Сентрас Иншуранс")

        # Take a screenshot of the video page
        page.screenshot(path="verification/video_page.png")

        browser.close()

if __name__ == "__main__":
    print("Verifying homepage...")
    verify_homepage()
    print("Verifying video page...")
    verify_video_page()
