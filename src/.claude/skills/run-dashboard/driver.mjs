#!/usr/bin/env node
// Drives the RackWatch dashboard (a Vite dev server) with a real,
// system-installed Chrome via playwright-core, and captures a
// screenshot plus extracted banner/column text for a fast text-based
// sanity check alongside the visual artifact.
//
// chromium-cli was not available in this environment, so this uses
// playwright-core (driver library only - no bundled Chromium download)
// with channel: "chrome" to reuse the OS's existing Chrome install
// instead. If chromium-cli IS available where you're running this,
// prefer it - see SKILL.md.
//
// Usage: node driver.mjs [url] [screenshot-out-path]
//   url                 defaults to http://localhost:5173
//   screenshot-out-path defaults to ./screenshot.png (relative to cwd)

import { chromium } from "playwright-core";
import path from "node:path";

const url = process.argv[2] ?? "http://localhost:5173";
const outPath = path.resolve(process.argv[3] ?? "./screenshot.png");

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("text=RACKWATCH", { timeout: 15000 });
  // Either the fault banner or the all-healthy banner - whichever the
  // fixture produced. Don't hardcode one; the fixture picks the scenario.
  await page.waitForSelector(".banner", { timeout: 15000 });
  await page.waitForTimeout(300); // let the WS message finish applying to React state

  await page.screenshot({ path: outPath });

  const bannerText = await page.locator(".banner").innerText();
  const columnsLocator = page.locator(".kiosk-columns");
  const columnsText = (await columnsLocator.count()) > 0 ? await columnsLocator.innerText() : "(no columns rendered)";

  console.log("=== banner text ===");
  console.log(bannerText);
  console.log("=== columns text ===");
  console.log(columnsText);
  console.log("=== console errors ===");
  console.log(consoleErrors.length ? consoleErrors.join("\n") : "(none)");
  console.log(`=== screenshot ===\n${outPath}`);

  await browser.close();

  if (consoleErrors.length > 0) {
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error("driver.mjs FAILED:", err);
  process.exit(1);
});
