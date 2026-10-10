import { expect, test } from "@playwright/test";

test("mobile: drawer navigation and conversation view", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.locator(".row")).toHaveCount(11);
  await expect(page.locator(".sidebar")).not.toBeInViewport();
  await page.getByRole("button", { name: "Main menu" }).click();
  await expect(page.locator(".sidebar")).toBeInViewport();
  await page.locator(".nav-item", { hasText: "Sent" }).click();
  await expect(page.locator(".row")).toHaveCount(3);
  await page.locator(".row").first().click();
  await expect(page.locator(".thread-subject h1")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
