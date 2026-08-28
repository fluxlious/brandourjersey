/**
 * Builds index.html from src/page.html.
 *
 * The source keeps two placeholders so the same markup can ship twice: the
 * site references the image files, while a standalone copy inlines them.
 *
 *   node build.js          -> index.html with checkout off (buttons email us)
 *   node build.js --local  -> also local-test.html, checkout on, for testing
 *   node build.js --live   -> index.html with checkout ON
 *
 * Only pass --live once Dodo is approved AND wrangler.toml says live_mode.
 * In test mode a real visitor could buy a spot with a test card.
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const API = "https://brandourjersey-api.dortmundwolves.workers.dev";

const src = fs.readFileSync(path.join(ROOT, "src", "page.html"), "utf8");

for (const token of ["LOGO_DATA_URI", "TEAM_PHOTO_DATA_URI"]) {
  if (!src.includes(token)) {
    console.error(`src/page.html has lost its ${token} placeholder — refusing to build.`);
    process.exit(1);
  }
}

const page = src
  .replace(/LOGO_DATA_URI/g, "logo.png")
  .replace(/TEAM_PHOTO_DATA_URI/g, "team.jpg");

const live = process.argv.includes("--live");
let html = `<!doctype html>\n<html lang="en">\n${page}\n</html>\n`;
if (live) html = html.replace('var API_BASE = "";', `var API_BASE = "${API}";`);

fs.writeFileSync(path.join(ROOT, "index.html"), html, "utf8");
console.log(
  `index.html  ${(html.length / 1024).toFixed(1)} KB  checkout ${live ? "ON" : "off"}`,
);

if (process.argv.includes("--local")) {
  const local = html.replace('var API_BASE = "";', `var API_BASE = "${API}";`);
  fs.writeFileSync(path.join(ROOT, "local-test.html"), local, "utf8");
  console.log("local-test.html  checkout pointed at the Worker");
}
