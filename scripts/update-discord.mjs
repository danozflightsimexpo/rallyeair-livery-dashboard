const initMode = process.argv.includes("--init");
const required = ["DISCORD_WEBHOOK_URL", "SHEET_CSV_URL", "DASHBOARD_URL"];
if (!initMode) required.push("DISCORD_MESSAGE_ID");

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const webhook = process.env.DISCORD_WEBHOOK_URL.replace(/\/$/, "");
const csvUrl = process.env.SHEET_CSV_URL;
const dashboardUrl = process.env.DASHBOARD_URL;
const messageId = process.env.DISCORD_MESSAGE_ID || "";
const title = process.env.DASHBOARD_TITLE || "RallyeAir Livery Production";

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && n === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(v => v.trim());
  return rows.map(values =>
    Object.fromEntries(headers.map((h, i) => [h, (values[i] || "").trim()]))
  );
}

function pct(raw) {
  let n = parseFloat(String(raw ?? "").replace("%", ""));
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) n *= 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalise(r) {
  return {
    aircraft: r["Aircraft"] || "",
    variant: r["Variant / Model"] || "",
    registration: r["Registration"] || "",
    developer: r["Developer / Paint Kit"] || "",
    priority: r["Priority"] || "",
    status: r["Status"] || "Not Started",
    progress: pct(r["Progress"]),
    currentTask: r["Current Task"] || "",
    nextTask: r["Next Task"] || "",
    updated: r["Last Updated"] || ""
  };
}

function truncate(v, max) {
  const s = String(v || "");
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function bar(p) {
  const filled = Math.round(p / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function emoji(status) {
  return ({
    "Not Started":"⚪","Templates":"🔵","Painting":"🟣","Testing":"🟡",
    "Thumbnail Required":"🟠","Packaging":"🟤","Released":"🟢","Needs Rework":"🔴"
  })[status] || "⚪";
}

async function loadData() {
  const res = await fetch(csvUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet CSV failed: HTTP ${res.status}`);
  const data = parseCSV(await res.text()).map(normalise)
    .filter(x => x.aircraft || x.registration);
  if (!data.length) throw new Error("No livery rows found.");
  return data;
}

function payload(items) {
  const total = items.length;
  const released = items.filter(x => x.status === "Released").length;
  const rework = items.filter(x => x.status === "Needs Rework").length;
  const active = items.filter(x => !["Released","Not Started","Needs Rework"].includes(x.status)).length;
  const overall = Math.round(items.reduce((s, x) => s + x.progress, 0) / total);

  const statusOrder = ["Needs Rework","Testing","Packaging","Thumbnail Required","Painting","Templates","Not Started","Released"];
  const priorityOrder = {High:0, Medium:1, Low:2};

  const current = [...items].filter(x => x.status !== "Released").sort((a,b) => {
    const s = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
    if (s) return s;
    const p = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
    return p || b.progress - a.progress;
  }).slice(0, 8);

  const currentText = current.length ? current.map(x => {
    const name = `${x.aircraft}${x.variant ? " " + x.variant : ""}`;
    const task = x.nextTask || x.currentTask || "No next task recorded";
    return `${emoji(x.status)} **${truncate(name,40)} · ${truncate(x.registration || "TBA",12)}**\n` +
           `${bar(x.progress)} **${x.progress}%** — ${truncate(x.status,24)}\n` +
           `Next: ${truncate(task,75)}`;
  }).join("\n\n") : "No active liveries.";

  const statuses = ["Not Started","Templates","Painting","Testing","Thumbnail Required","Packaging","Released","Needs Rework"];
  const pipelineText = statuses.map(s =>
    `${emoji(s)} ${s}: **${items.filter(x => x.status === s).length}**`
  ).join("\n");

  const latest = [...items].filter(x => x.status === "Released")
    .sort((a,b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0,4);

  const releasedText = latest.length ? latest.map(x =>
    `🟢 **${truncate(x.aircraft,38)} · ${truncate(x.registration || "TBA",12)}**${x.updated ? " — " + truncate(x.updated,18) : ""}`
  ).join("\n") : "No liveries released yet.";

  return {
    username: "RallyeAir Production",
    allowed_mentions: { parse: [] },
    embeds: [{
      title,
      url: dashboardUrl,
      description:
        `**${total}** tracked • **${released}** released • **${active}** active • **${rework}** needing rework\n\n` +
        `${bar(overall)} **${overall}% overall completion**`,
      color: 0x38BDF8,
      fields: [
        { name: "Current Work", value: truncate(currentText,1024), inline: false },
        { name: "Pipeline", value: truncate(pipelineText,1024), inline: true },
        { name: "Latest Releases", value: truncate(releasedText,1024), inline: true },
        { name: "Full Live Dashboard", value: `[Open the interactive dashboard](${dashboardUrl})`, inline: false }
      ],
      footer: { text: "Automatically refreshed from the live livery tracker." },
      timestamp: new Date().toISOString()
    }]
  };
}

async function send(body) {
  const url = initMode ? `${webhook}?wait=true` : `${webhook}/messages/${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    method: initMode ? "POST" : "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord failed: HTTP ${res.status}\n${text}`);

  if (initMode) {
    const message = JSON.parse(text);
    console.log(`Message ID: ${message.id}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = await import("node:fs/promises");
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## Discord message created\n\nAdd this as the repository secret \`DISCORD_MESSAGE_ID\`:\n\n\`${message.id}\`\n\nThen pin the Discord message and run the refresh workflow.\n`
      );
    }
  } else {
    console.log(`Updated Discord message ${messageId}.`);
  }
}

try {
  const items = await loadData();
  await send(payload(items));
} catch (err) {
  console.error(err?.stack || err);
  process.exit(1);
}
