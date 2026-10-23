import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const token = env.NOTION_TOKEN;
const H = { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" };
const root = (env.NOTION_ROOT_PAGE.match(/[0-9a-fA-F]{32}/g) ?? []).pop();
const page = await (await fetch("https://api.notion.com/v1/pages", { method: "POST", headers: H, body: JSON.stringify({ parent: { page_id: root }, properties: { title: { title: [{ text: { content: "nhs-probe-trash" } }] } } }) })).json();
console.log("page", page.id);
const tryReq = async (label, url) => {
  const r = await fetch(url, { headers: H });
  const j = await r.json().catch(() => null);
  console.log(label, r.status, j?.code ?? "", (j?.message ?? "").slice(0, 90));
};
await tryReq("live md:", `https://api.notion.com/v1/pages/${page.id}/markdown`);
await tryReq("live children:", `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`);
await tryReq("live page:", `https://api.notion.com/v1/pages/${page.id}`);
// trash it
await fetch(`https://api.notion.com/v1/pages/${page.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ in_trash: true }) });
await new Promise(r => setTimeout(r, 2000));
await tryReq("trash md:", `https://api.notion.com/v1/pages/${page.id}/markdown`);
await tryReq("trash children:", `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`);
await tryReq("trash page:", `https://api.notion.com/v1/pages/${page.id}`);
