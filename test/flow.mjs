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
let vase = (await alice.json("GET", "/api/vase")).blooms;
assert(vase.length === 4, "4 blooms in vase");
const { seedId } = await alice.json("POST", "/api/pollinate", { a: vase[0].id, b: vase[1].id });
assert(seedId, "pollinate gives a hybrid seed");
// profiles and featured flowers (#13)
await alice.json("POST", "/api/feature", { bloomId: vase[0].id, slot: 0 });
await alice.json("POST", "/api/feature", { bloomId: vase[1].id, slot: 1 });
await alice.json("POST", "/api/feature", { bloomId: vase[2].id, slot: 0 });   // swaps: vase[0] moves out
let prof = await alice.json("GET", "/api/public/u/ALICE");
assert(prof.username === "alice" && prof.featured.map((b) => b.id).join() === [vase[2].id, vase[1].id].join(), "featured slots swap and show on the profile");
await alice.json("POST", "/api/profile", { bio: "  I grow\n\n\n\nblue things  " });
prof = await alice.json("GET", "/api/public/u/alice");
assert(prof.bio === "I grow\n\nblue things" && prof.stats.grown === 4, "bio is cleaned and stats count harvests");
const tooLong = await alice.json("POST", "/api/profile", { bio: "x".repeat(281) }).catch((e) => e.message);
assert(String(tooLong).includes("280"), "bio length limit");
const badSlot = await alice.json("POST", "/api/feature", { bloomId: vase[3].id, slot: 9 }).catch((e) => e.message);
assert(String(badSlot).includes("slot"), "featured slots are 0-4");
const nobody = await fetch(BASE + "/api/public/u/nobody-here");
assert(nobody.status === 404, "unknown profile is 404");
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
vase = (await alice.json("GET", "/api/vase")).blooms;
assert(vase.find((b) => b.id === target.id).state === "vase", "denied export returns to vase");
ex = await alice.json("POST", "/api/export", { bloomId: target.id });
await alice.consent(ex.consentUrl, "approve");
vase = (await alice.json("GET", "/api/vase")).blooms;
assert(!vase.find((b) => b.id === target.id), "exported bloom leaves vase");
assert(!(await alice.json("GET", "/api/public/u/alice")).featured.find((b) => b.id === target.id), "an exported bloom is no longer featured");
let inv = await alice.json("GET", "/api/serble/inventory");
assert(inv.length === 1 && inv[0].bloom.id === target.id, "item in alice's serble inventory");
const item = await alice.json("GET", "/__mock/item/" + inv[0].itemId);
assert(/^https:\/\/api\.files\.serble\.net\/files\/.+\.png$/.test(item.iconUrl ?? ""), "exported item has a Serble Files icon");

// trade to bob (as the market would), bob imports
const bob = client();
await bob.login("bob");
await bob.json("POST", "/__mock/give", { itemId: inv[0].itemId, to: "bob" });
inv = await bob.json("GET", "/api/serble/inventory");
assert(inv.length === 1, "bob sees item");
const im = await bob.json("POST", "/api/import", { itemIds: [inv[0].itemId] });
await bob.consent(im.consentUrl, "approve");
const bv = (await bob.json("GET", "/api/vase")).blooms;
assert(bv.length === 1 && bv[0].id === target.id && bv[0].itemId === inv[0].itemId, "bob imported the bloom");
const pub = await bob.json("GET", "/api/public/bloom/" + target.id);
assert(pub.owner === "bob" && pub.grower === "alice", "public page shows grower and owner");
// re-export by bob reuses the same item
const ex2 = await bob.json("POST", "/api/export", { bloomId: target.id });
await bob.consent(ex2.consentUrl, "approve");
inv = await bob.json("GET", "/api/serble/inventory");
assert(inv.length === 1 && inv[0].bloom.id === target.id, "bob re-exports same item");
const stats = await bob.json("GET", "/api/public/stats");
assert(stats.gardeners >= 2, "stats count both test gardeners");
const svg = await fetch(BASE + `/bloom/${target.id}.svg`);
assert(svg.ok && svg.headers.get("content-type").includes("svg"), "svg image");
const cross = await fetch(BASE + "/api/seeds/claim", { method: "POST", headers: { origin: "https://evil.example" } });
assert(cross.status === 403, "cross-site post refused");
// compost (#9): alice composts a flower into fertiliser, then fertilises a growing plant
const v0 = await alice.json("GET", "/api/vase");
const victim = v0.blooms.find((b) => b.state === "vase");
const c = await alice.json("POST", "/api/compost-blooms", { bloomIds: [victim.id] });
assert(c.composted === 1 && c.gained === v0.compostYield[victim.rarity], "compost gives fertiliser by rarity");
const notMine = await (await fetch(BASE + "/api/compost-blooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bloomIds: [bv[0].id] }) })).status;
assert(notMine === 401, "compost needs sign-in");
// give alice enough fertiliser by composting more of her flowers
const more = (await alice.json("GET", "/api/vase")).blooms.filter((b) => b.state === "vase").map((b) => b.id);
const c2 = await alice.json("POST", "/api/compost-blooms", { bloomIds: more });
const gAl = await alice.json("GET", "/api/garden");
assert(gAl.fertiliser === c.gained + c2.gained, "fertiliser total adds up");
const seed = gAl.seeds[0];
const slot = gAl.plots.find((p) => !p.plant).slot;
await alice.json("POST", "/api/plant", { seedId: seed.id, slot });
const before = (await alice.json("GET", "/api/garden")).plots[slot].plant.readyAt;
if (gAl.fertiliser >= gAl.fertiliseCost) {
  const f = await alice.json("POST", "/api/fertilise", { slot });
  const after = (await alice.json("GET", "/api/garden")).plots[slot].plant.readyAt;
  assert(f.fertiliser === gAl.fertiliser - gAl.fertiliseCost && after < before, "fertilising spends fertiliser and speeds growth");
} else {
  const r = await alice.json("POST", "/api/fertilise", { slot }).catch((e) => e.message);
  assert(String(r).includes("need"), "fertilising without enough is refused");
}
// weekly commissions (#2)
const { exampleGenome } = await import("../shared/commission.ts");
const com = await alice.json("GET", "/api/commission");
assert(com.title && com.requirements.length >= 2 && com.requirements.some((q) => q.kind === "generation") && com.claims.length === 0, "this week's commission: " + com.title);
const base = { hue: 30, hue2: 200, sat: 60, lum: 55, petals: 6, shape: 0, layers: 1, pattern: 0, center: 0, centerHue: 50, stem: 0.5, leaves: 2, curl: 0, glow: false, iridescent: false };
const winning = exampleGenome(com, base);
await alice.json("POST", "/__mock/set-app-balance", { raw: String(30n << 24n) });        // enough for first place only
const ga = await alice.json("POST", "/__mock/grant-bloom", { username: "alice", genome: winning });
const plainBloom = await alice.json("POST", "/__mock/grant-bloom", { username: "alice", genome: base });
const wrong = await alice.json("POST", "/api/commission/claim", { bloomId: plainBloom.id }).catch((e) => e.message);
assert(String(wrong).includes("doesn't match"), "a non-matching flower is refused");
const bal0 = (await alice.json("GET", "/api/balance")).coins;
const c1 = await alice.json("POST", "/api/commission/claim", { bloomId: ga.id });
assert(c1.place === 1 && c1.status === "paid" && c1.reward === "25", "first place is paid 25 coins");
const bal1 = (await alice.json("GET", "/api/balance")).coins;
assert(Number(bal1) - Number(bal0) === 25, `alice's Serble balance went up by 25 (${bal0} -> ${bal1})`);
const again = await alice.json("POST", "/api/commission/claim", { bloomId: ga.id }).catch((e) => e.message);
assert(String(again).includes("already claimed"), "one claim per gardener per week");
// a flower grown by someone else (e.g. bought on the market) doesn't count
const gifted = await bob.json("POST", "/__mock/grant-bloom", { username: "bob", grower: "alice", genome: winning });
const notGrown = await bob.json("POST", "/api/commission/claim", { bloomId: gifted.id }).catch((e) => e.message);
assert(String(notGrown).includes("grew yourself"), "only flowers you grew count");
// second place, but the app only has 5 coins left: the claim is owed, then paid once funded
const gb = await bob.json("POST", "/__mock/grant-bloom", { username: "bob", genome: winning });
const cl2 = await bob.json("POST", "/api/commission/claim", { bloomId: gb.id });
assert(cl2.place === 2 && cl2.status === "owed" && cl2.reward === "15", "second place is owed when the app can't afford it yet");
await bob.json("POST", "/__mock/fund-app", { raw: String(20n << 24n) });
await bob.json("POST", "/__mock/reconcile", {});
const comAfter = await bob.json("GET", "/api/commission");
assert(comAfter.mine?.status === "paid" && comAfter.claims.map((x) => x.username).join() === "alice,bob", "the owed reward is paid once the app has funds");
// a payment that happened but wasn't recorded must not be paid again
await alice.json("POST", "/__mock/forget-payment", { username: "alice" });
const appBefore = (await alice.json("GET", "/__mock/app-balance")).raw;
await alice.json("POST", "/__mock/reconcile", {});
const appAfter = (await alice.json("GET", "/__mock/app-balance")).raw;
const aliceClaim = (await alice.json("GET", "/api/commission")).mine;
assert(aliceClaim.status === "paid" && appBefore === appAfter, "an unrecorded payment is found in the ledger, not paid twice");
// reactions (#13) and flower of the day (#14)
const fav = await alice.json("POST", "/__mock/grant-bloom", { username: "alice", genome: { ...base, glow: true } });
const own = await alice.json("POST", "/api/react", { bloomId: fav.id, kind: "love" }).catch((e) => e.message);
assert(String(own).includes("own flower"), "you can't react to your own flower");
let rs = await bob.json("POST", "/api/react", { bloomId: fav.id, kind: "love" });
assert(rs.counts.love === 1 && rs.mine === "love", "bob loves alice's flower");
rs = await bob.json("POST", "/api/react", { bloomId: fav.id, kind: "wow" });
assert(rs.counts.love === 0 && rs.counts.wow === 1 && rs.total === 1, "changing a reaction replaces it");
rs = await bob.json("POST", "/api/react", { bloomId: fav.id, kind: "wow" });
assert(rs.total === 0 && rs.mine === null, "the same reaction again removes it");
await bob.json("POST", "/api/react", { bloomId: fav.id, kind: "sparkle" });
const bad = await bob.json("POST", "/api/react", { bloomId: fav.id, kind: "<script>" }).catch((e) => e.message);
assert(String(bad).includes("Unknown"), "only known reactions are accepted");
const fotd = (await bob.json("GET", "/api/public/flower-of-the-day")).flower;
assert(fotd && fotd.bloomId === fav.id && fotd.reason === "reactions" && fotd.grower === "alice", "flower of the day is the most-reacted flower");
const again2 = (await bob.json("GET", "/api/public/flower-of-the-day")).flower;
assert(again2.bloomId === fotd.bloomId, "the pick is fixed for the day");
// Almanac search (#13)
let found = await bob.json("GET", "/api/public/search?q=ALI");
assert(found.gardeners.some((g) => g.username === "alice"), "search finds gardeners, case-insensitively");
const anySpecies = (await bob.json("GET", "/api/public/almanac"))[0];
found = await bob.json("GET", "/api/public/search?q=" + encodeURIComponent(anySpecies.name.split(" ").pop()));
assert(found.species.some((x) => x.name === anySpecies.name), "search finds species by name");
found = await bob.json("GET", "/api/public/search?q=" + encodeURIComponent("%%"));
assert(found.gardeners.length === 0 && found.species.length === 0, "% is matched literally, not as a wildcard");
found = await bob.json("GET", "/api/public/search?q=a");
assert(found.gardeners.length === 0, "one-letter searches return nothing");
const alm = await bob.json("GET", "/api/public/almanac");
assert(alm.length > 0 && alm.every((x) => x.genome) && alm.some((x) => !x.alive), "species whose first flower was composted still have art");
// gifts (#3)
const gift = await alice.json("POST", "/__mock/grant-bloom", { username: "alice", genome: winning });
await alice.json("POST", "/api/feature", { bloomId: gift.id, slot: 4 });
const self = await alice.json("POST", "/api/gift", { bloomId: gift.id, to: "ALICE" }).catch((e) => e.message);
assert(String(self).includes("That's you"), "can't gift to yourself");
const nobody2 = await alice.json("POST", "/api/gift", { bloomId: gift.id, to: "ghost" }).catch((e) => e.message);
assert(String(nobody2).includes("no gardener"), "can't gift to someone who doesn't play");
const sentGift = await alice.json("POST", "/api/gift", { bloomId: gift.id, to: "@Bob" });
assert(sentGift.to === "bob", "alice gifts bob a flower");
const bobVase = (await bob.json("GET", "/api/vase")).blooms;
const got = bobVase.find((x) => x.id === gift.id);
assert(got && got.featuredSlot === null, "it arrives in bob's vase and is no longer featured");
const inbox = await bob.json("GET", "/api/gifts/new");
assert(inbox.length === 1 && inbox[0].sender === "alice", "bob sees who sent it");
await bob.json("POST", "/api/gifts/seen", {});
assert((await bob.json("GET", "/api/gifts/new")).length === 0, "acknowledged gifts go away");
const stolen = await alice.json("POST", "/api/gift", { bloomId: gift.id, to: "bob" }).catch((e) => e.message);
assert(String(stolen).includes("isn't in your vase"), "alice can't gift it again");
const gp = await bob.json("GET", "/api/public/bloom/" + gift.id);
assert(gp.grower === "alice" && gp.owner === "bob", "a gift keeps its grower");
// family tree (#4)
const lt = await bob.json("GET", `/api/public/bloom/${gift.id}/lineage`);
assert(lt.id === gift.id && Array.isArray(lt.parents), "lineage endpoint returns a tree");
const lt404 = await fetch(BASE + "/api/public/bloom/nope/lineage");
assert(lt404.status === 404, "lineage of an unknown flower is 404");
console.log("ALL PASSED");
