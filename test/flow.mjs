// End-to-end run of the game against the mock Serble. Usage: BASE=http://localhost:8090 node test/flow.mjs
const BASE = process.env.BASE ?? "http://localhost:8090";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  let cookie = "";
  const req = async (method, path, body, form) => {
    const headers = { cookie };
    let payload;
    if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) if (c.startsWith("pollen_sid=")) cookie = c.split(";")[0];
    return res;
  };
  const json = async (method, path, body) => {
    const r = await req(method, path, body);
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const follow = async (url, method = "GET", form) => {
    let r = await req(method, url.replace(BASE, ""), undefined, form);
    while (r.status >= 300 && r.status < 400) {
      const loc = new URL(r.headers.get("location"), BASE).toString();
      r = await req("GET", loc.replace(BASE, ""));
      url = loc;
    }
    return { r, url };
  };
  return {
    json, follow,
    async login(name) {
      const r1 = await req("GET", "/auth/login");
      const authUrl = new URL(r1.headers.get("location"));
      const r2 = await req("POST", "/__mock/login", undefined, { username: name, redirect_uri: authUrl.searchParams.get("redirect_uri"), state: authUrl.searchParams.get("state") });
      const cb = new URL(r2.headers.get("location"));
      const r3 = await req("GET", cb.pathname + cb.search);
      return r3.headers.get("location");
    },
    async consent(consentUrl, decision) {
      const id = new URL(consentUrl).searchParams.get("proposal");
      return (await follow(`/__mock/consent/${id}/${decision}`, "POST")).url;
    },
  };
}
const assert = (c, m) => { if (!c) throw new Error("ASSERT: " + m); console.log("  ok:", m); };

const alice = client();
assert((await alice.login("alice")) === "/garden", "alice signs in");
let me = await alice.json("GET", "/api/me");
assert(me.user.username === "alice", "me");
let g = await alice.json("GET", "/api/garden");
assert(g.seeds.length === 4 && g.plots.length === 6, "starter seeds and plots");
for (let i = 0; i < 4; i++) await alice.json("POST", "/api/plant", { seedId: g.seeds[i].id, slot: i });
await alice.json("POST", "/api/water", { slot: 0 });
await sleep(7000);  // GROW_SCALE=0.001 -> 1.5h ~ 5.4s
g = await alice.json("GET", "/api/garden");
assert(g.plots.slice(0, 4).every((p) => p.plant.stage === "bloom"), "plants bloom");
for (let i = 0; i < 4; i++) await alice.json("POST", "/api/harvest", { slot: i });
let vase = await alice.json("GET", "/api/vase");
assert(vase.length === 4, "4 blooms in vase");
const { seedId } = await alice.json("POST", "/api/pollinate", { a: vase[0].id, b: vase[1].id });
assert(seedId, "pollinate gives a hybrid seed");
let err = await (await fetch(BASE + "/api/pollinate", { method: "POST" })).status;
assert(err === 401, "anon blocked");

// buy a packet
const pk = await alice.json("POST", "/api/shop/packet");
const back = await alice.consent(pk.consentUrl, "approve");
assert(back.includes("/garden?trade=packet&status=Approved"), "packet approved -> " + back);
g = await alice.json("GET", "/api/garden");
assert(g.seeds.filter((s) => s.origin === "packet").length === 3, "3 packet seeds");
assert((await alice.json("GET", "/api/balance")).coins === "90", "balance 90");

// export denied, then approved
const target = vase[2];
let ex = await alice.json("POST", "/api/export", { bloomId: target.id });
await alice.consent(ex.consentUrl, "deny");
vase = await alice.json("GET", "/api/vase");
assert(vase.find((b) => b.id === target.id).state === "vase", "denied export returns to vase");
ex = await alice.json("POST", "/api/export", { bloomId: target.id });
await alice.consent(ex.consentUrl, "approve");
vase = await alice.json("GET", "/api/vase");
assert(!vase.find((b) => b.id === target.id), "exported bloom leaves vase");
let inv = await alice.json("GET", "/api/serble/inventory");
assert(inv.length === 1 && inv[0].bloom.id === target.id, "item in alice's serble inventory");

// trade to bob (as the market would), bob imports
const bob = client();
await bob.login("bob");
await bob.json("POST", "/__mock/give", { itemId: inv[0].itemId, to: "bob" });
inv = await bob.json("GET", "/api/serble/inventory");
assert(inv.length === 1, "bob sees item");
const im = await bob.json("POST", "/api/import", { itemIds: [inv[0].itemId] });
await bob.consent(im.consentUrl, "approve");
const bv = await bob.json("GET", "/api/vase");
assert(bv.length === 1 && bv[0].id === target.id && bv[0].itemId === inv[0].itemId, "bob imported the bloom");
const pub = await bob.json("GET", "/api/public/bloom/" + target.id);
assert(pub.owner === "bob" && pub.grower === "alice", "public page shows grower and owner");
// re-export by bob reuses the same item
const ex2 = await bob.json("POST", "/api/export", { bloomId: target.id });
await bob.consent(ex2.consentUrl, "approve");
inv = await bob.json("GET", "/api/serble/inventory");
assert(inv.length === 1 && inv[0].bloom.id === target.id, "bob re-exports same item");
const stats = await bob.json("GET", "/api/public/stats");
assert(stats.gardeners === 2, "stats");
const svg = await fetch(BASE + `/bloom/${target.id}.svg`);
assert(svg.ok && svg.headers.get("content-type").includes("svg"), "svg image");
const cross = await fetch(BASE + "/api/seeds/claim", { method: "POST", headers: { origin: "https://evil.example" } });
assert(cross.status === 403, "cross-site post refused");
console.log("ALL PASSED");
