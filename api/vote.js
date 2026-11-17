// Shared vote counter for the "Spot the Machine" test.
// Storage: Upstash Redis over REST (connect it in Vercel: Storage -> Upstash for Redis).
// Reveal and reset need the password (HOST_KEY in Vercel, or 777 if it is not set).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HOST = process.env.HOST_KEY || "777";

async function redis(...parts) {
  const r = await fetch(URL_ + "/" + parts.map(p => encodeURIComponent(String(p))).join("/"), {
    headers: { Authorization: "Bearer " + TOKEN }
  });
  if (!r.ok) throw new Error("redis " + r.status);
  return (await r.json()).result;
}

async function readState() {
  const [a, b, rev, round] = await redis("mget", "stm:A", "stm:B", "stm:revealed", "stm:round");
  return { A: Number(a) || 0, B: Number(b) || 0, revealed: rev === "1", round: Number(round) || 0 };
}

function body(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return req.body;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(503).json({ error: "storage_not_connected" });
  try {
    if (req.method === "GET") return res.status(200).json(await readState());
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const b = body(req);
    if (b.action === "vote") {
      const choice = b.choice, id = String(b.id || "");
      if (!["A", "B"].includes(choice) || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: "bad_vote" });
      const now = await readState();
      if (now.revealed) return res.status(200).json({ ...now, accepted: false });
      // one vote per device per round; voting for the other ad moves the vote instead of adding one
      const key = "stm:voter:" + now.round + ":" + id;
      const prev = await redis("get", key);
      if (prev === choice) return res.status(200).json({ ...now, accepted: false });
      await redis("set", key, choice, "EX", "86400");
      if (prev === "A" || prev === "B") await redis("decr", "stm:" + prev);
      await redis("incr", "stm:" + choice);
      return res.status(200).json({ ...(await readState()), accepted: true });
    }

    if (!HOST || b.key !== HOST) return res.status(403).json({ error: "not_host" });
    if (b.action === "reveal") {
      await redis("set", "stm:revealed", b.on ? "1" : "0");
      return res.status(200).json(await readState());
    }
    if (b.action === "reset") {
      await redis("del", "stm:A", "stm:B", "stm:revealed");
      await redis("incr", "stm:round");
      return res.status(200).json(await readState());
    }
    return res.status(400).json({ error: "unknown_action" });
  } catch (e) {
    return res.status(500).json({ error: "storage_error" });
  }
};
