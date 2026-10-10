import { expect, type Page, test } from "@playwright/test";

const rows = (page: Page) => page.locator(".row");
async function search(page: Page, q: string) {
  await page.goto(`/demo#search/${encodeURIComponent(q)}`);
  // a hash-only navigation keeps the page, so wait for this search (not the previous view) to finish
  await expect(page.locator(".search input")).toHaveValue(q);
  await expect(page.locator(".progress-bar")).toHaveCount(0);
  await expect(page.locator(".thread-list .toolbar .pager-text, .empty").first()).toBeVisible();
}

test("single mailbox: / redirects to it and the inbox lists conversations", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/demo/);
  await expect(rows(page)).toHaveCount(11);
  await expect(page.locator(".nav-item.active")).toContainText("Inbox");
  await expect(page.locator(".row.unread")).toHaveCount(11);
});

test("opening a conversation shows messages, marks it read, and u goes back", async ({ page }) => {
  await page.goto("/demo");
  await page.locator(".row", { hasText: "Playground renovation budget" }).locator(".row-subject").click();
  await expect(page.locator(".thread-subject h1")).toHaveText("Playground renovation budget");
  await expect(page.locator(".msg")).toHaveCount(4);
  await expect(page.locator(".msg.expanded")).toHaveCount(1); // latest open, older collapsed
  await page.locator(".msg.collapsed").first().click();
  await expect(page.locator(".att-card")).toContainText("budget-2024.pdf");
  await page.keyboard.press("u");
  await expect(rows(page)).toHaveCount(11);
  await expect(page.locator(".row.unread")).toHaveCount(10);
  await expect(page.locator(".nav-item.active .nav-count")).toHaveText("10");
});

test("keyboard: j moves the cursor, o opens, k/j step between conversations", async ({ page }) => {
  await page.goto("/demo");
  await expect(rows(page)).toHaveCount(11);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("o");
  await expect(page.locator(".thread-subject h1")).toHaveText("Bids for pool resurfacing");
  await page.keyboard.press("j");
  await expect(page.locator(".thread-subject h1")).toHaveText("Staff meeting notes");
});

test("operators, phrases, attachment text, accents and CJK", async ({ page }) => {
  await search(page, "from:marco");
  await expect(rows(page)).toHaveCount(2);
  await search(page, '"safety surfacing"');
  await expect(rows(page).first()).toContainText("Playground renovation budget");
  await search(page, "BlueLine"); // only inside pool-bids.xlsx
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Bids for pool resurfacing");
  await search(page, "iluminacion");
  await expect(rows(page).first()).toContainText("iluminación");
  await search(page, "ベンチ");
  await expect(rows(page).first()).toContainText("公園のベンチについて");
  await search(page, "has:spreadsheet -contract");
  await expect(page.locator(".empty")).toBeVisible();
  await search(page, "{from:ortiz to:ortiz}");
  await expect(rows(page)).toHaveCount(2);
});

test("spam and trash stay out of All Mail and search unless asked for", async ({ page }) => {
  await page.goto("/demo#all");
  await expect(rows(page)).toHaveCount(12); // 14 threads minus spam and trash
  await search(page, "cruise");
  await expect(page.locator(".empty")).toBeVisible();
  await search(page, "cruise in:spam");
  await expect(rows(page)).toHaveCount(1);
});

test("labels from nested folders, and the search chips edit the query", async ({ page }) => {
  await page.goto(`/demo#label/${encodeURIComponent("Projects/Playground")}`);
  await expect(rows(page)).toHaveCount(2);
  await search(page, "pool");
  await page.getByRole("button", { name: "Has attachment" }).click();
  await expect(page.locator(".search input")).toHaveValue("pool has:attachment");
  await expect(rows(page)).toHaveCount(1);
});

test("HTML mail: inline image shown, remote images blocked until asked", async ({ page }) => {
  await page.goto("/demo");
  await page.locator(".row", { hasText: "Dog run location" }).locator(".row-subject").click();
  const frame = page.frameLocator(".html-body iframe");
  await expect(frame.locator("img[alt=map]")).toHaveJSProperty("naturalWidth", 16);
  await expect(page.locator(".quote-toggle")).toBeVisible(); // Outlook quoted reply trimmed
  await search(page, '"Parks Weekly #1"');
  await page.locator(".row", { hasText: "Parks Weekly #1" }).locator(".row-subject").click();
  await expect(page.locator(".images-banner")).toBeVisible();
  const tracker = frame.locator("img[width='1']");
  await expect(tracker).not.toHaveAttribute("src", /tracker/);
});

test("attachment preview shows extracted text for office files", async ({ page }) => {
  await page.goto("/demo");
  await page.locator(".row", { hasText: "Bids for pool resurfacing" }).locator(".row-subject").click();
  await page.locator(".att-card", { hasText: "contract-draft.docx" }).locator(".att-thumb").click();
  await expect(page.locator(".preview-text")).toContainText("seven weeks");
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview")).toHaveCount(0);
});

test("stars persist and show in Starred", async ({ page }) => {
  await page.goto("/demo");
  await page.locator(".row", { hasText: "Staff meeting notes" }).locator(".star").click();
  await page.goto("/demo#starred");
  await expect(rows(page)).toHaveCount(1);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
});

test("parquet files are read with HTTP range requests, never downloaded whole", async ({ page }) => {
  const gets: { url: string; range?: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && r.url().endsWith(".parquet")) gets.push({ url: r.url(), range: r.headers().range });
  });
  await page.goto("/demo");
  await expect(rows(page)).toHaveCount(11);
  await search(page, '"safety surfacing" budget');
  await page.locator(".row .row-subject").first().click();
  await expect(page.locator(".msg").first()).toBeVisible();
  const files = new Set(gets.map((g) => g.url.split("/").pop()!.split(".")[0]));
  expect([...files].sort()).toEqual(expect.arrayContaining(["bodies", "messages", "phrases", "postings", "threads"]));
  expect(gets.filter((g) => !g.range)).toEqual([]);
});

test("OR groups, filename: scope, negated labels", async ({ page }) => {
  await search(page, "swings OR bench");
  await expect(rows(page)).toHaveCount(3); // playground budget, park tour, the bench email
  await search(page, "{swings bench}");
  await expect(rows(page)).toHaveCount(3);
  await search(page, "filename:att"); // attachment paths start with att/, names don't
  await expect(page.locator(".empty")).toBeVisible();
  await search(page, "-label:Projects/Playground cruise"); // spam stays excluded
  await expect(page.locator(".empty")).toBeVisible();
});

test("opening a result of an is:unread search doesn't loop", async ({ page }) => {
  let bodyReads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/bodies.")) bodyReads++;
  });
  await search(page, "is:unread pool");
  await page.locator(".row .row-subject").first().click();
  await expect(page.locator(".msg").first()).toBeVisible();
  const settled = bodyReads;
  await page.waitForTimeout(1500);
  expect(bodyReads - settled).toBeLessThanOrEqual(1);
  await expect(page.locator(".thread-subject h1")).toHaveText("Bids for pool resurfacing");
});

test("export the current list as CSV", async ({ page }) => {
  await search(page, "from:marco");
  await page.locator(".thread-list .toolbar .menu-wrap .icon-btn").click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByText(/Export these conversations/).click()]);
  const csv = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  const lines = csv.trim().split(/\r\n/);
  expect(lines[0]).toContain("date,from,to,cc,subject");
  expect(lines.length).toBe(1 + 5); // budget thread (4 messages) + pool bids
  expect(csv).toContain("pool-bids.xlsx");
  await expect(page.locator(".snackbar")).toHaveText("Exported 5 messages");
});

test("OR across operators, phrases, groups and multi-token words", async ({ page }) => {
  await search(page, "from:hiroshi OR from:ortiz");
  await expect(rows(page)).toHaveCount(4); // tree removal, bench, park tour, budget thread
  await search(page, '"safety surfacing" OR bench');
  await expect(rows(page)).toHaveCount(2);
  await search(page, "{swings OR bench}");
  await expect(rows(page)).toHaveCount(3);
  await search(page, "{from:ortiz bench}");
  await expect(rows(page)).toHaveCount(3); // ortiz's two threads + the bench email
  await search(page, "h.tanaka@mail.example.net OR jalvarez@vecinos.example.org");
  await expect(rows(page)).toHaveCount(3); // tree removal, bench, iluminación
  await search(page, "-{swings bench} park");
  await expect(rows(page).filter({ hasText: "Thank you for the park tour" })).toHaveCount(0);
});
