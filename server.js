const express = require("express");
const cors = require("cors");
const path = require("path");
const { CTraderConnection } = require("@reiryoku/ctrader-layer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CLIENT_ID = process.env.CTRADER_CLIENT_ID;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET;
const REDIRECT_URI = process.env.CTRADER_REDIRECT_URI;
const PORT = process.env.PORT || 3000;

let accessToken = null;
let connections = {};
let latestPrices = {};
let lastExecutions = {};
let symbolListCache = {};
let activeSymbolByAccount = {};

app.get("/login", (req, res) => {
  const url = `https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=trading`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");
  try {
    const tokenUrl = `https://openapi.ctrader.com/apps/token?grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`;
    const response = await fetch(tokenUrl, { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!data.accessToken) return res.status(400).json({ error: "Token exchange failed", details: data });
    accessToken = data.accessToken;
    res.redirect("/");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ connected: !!accessToken });
});

app.get("/api/accounts", async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: "Not connected. Please login again." });
  let connection;
  try {
    connection = new CTraderConnection({ host: "demo.ctraderapi.com", port: 5035 });
    await connection.open();
    await connection.sendCommand("ProtoOAApplicationAuthReq", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const result = await connection.sendCommand("ProtoOAGetAccountListByAccessTokenReq", { accessToken });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    if (connection) connection.close();
  }
});

async function fetchAndCacheSymbols(connection, accountId) {
  const symbolsData = await connection.sendCommand("ProtoOASymbolsListReq", { ctidTraderAccountId: accountId });
  const list = symbolsData.symbol || symbolsData.symbols || [];
  symbolListCache[accountId] = list.map(s => ({ symbolId: s.symbolId, symbolName: s.symbolName }));
  return symbolListCache[accountId];
}

async function subscribeSymbol(connection, accountId, symbolId) {
  const prevSymbolId = activeSymbolByAccount[accountId];
  if (prevSymbolId && prevSymbolId !== symbolId) {
    try {
      await connection.sendCommand("ProtoOAUnsubscribeSpotsReq", { ctidTraderAccountId: accountId, symbolId: [prevSymbolId] });
    } catch (e) {
      console.log("Unsubscribe old symbol failed:", e.message || e);
    }
  }
  await connection.sendCommand("ProtoOASubscribeSpotsReq", { ctidTraderAccountId: accountId, symbolId: [symbolId] });
  activeSymbolByAccount[accountId] = symbolId;
  latestPrices[accountId] = {};
  console.log("Subscribed account", accountId, "to symbolId", symbolId);
}

app.get("/api/connect/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  const isLive = req.query.live === "true";
  if (!accessToken) return res.status(401).json({ error: "Not connected. Please login again." });
  try {
    const connection = new CTraderConnection({ host: isLive ? "live.ctraderapi.com" : "demo.ctraderapi.com", port: 5035 });
    await connection.open();
    await connection.sendCommand("ProtoOAApplicationAuthReq", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await connection.sendCommand("ProtoOAAccountAuthReq", { accessToken, ctidTraderAccountId: accountId });
    connections[accountId] = connection;
    setInterval(() => connection.sendHeartbeat(), 25000);

    connection.on("ProtoOASpotEvent", (event) => {
      latestPrices[accountId] = { bid: event.bid, ask: event.ask };
    });
    connection.on("ProtoOAExecutionEvent", (event) => {
      lastExecutions[accountId] = event;
    });
    connection.on("ProtoOAOrderErrorEvent", (event) => {
      lastExecutions[accountId] = { error: true, description: event.description || event.errorCode };
    });

    const symbols = await fetchAndCacheSymbols(connection, accountId);
    const eurusd = symbols.find(s => s.symbolName === "EURUSD");
    let activeSymbolId = null;
    if (eurusd) {
      await subscribeSymbol(connection, accountId, eurusd.symbolId);
      activeSymbolId = eurusd.symbolId;
    }

    res.json({ status: "connected", accountId, activeSymbolId, activeSymbolName: eurusd ? eurusd.symbolName : null });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/symbols/:accountId", (req, res) => {
  const list = symbolListCache[req.params.accountId];
  if (!list) return res.status(400).json({ error: "Symbols not loaded yet. Connect first." });
  res.json({ symbols: list });
});

app.get("/api/switch-symbol/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  const symbolId = req.query.symbolId;
  const connection = connections[accountId];
  if (!connection) return res.status(400).json({ error: "Account not connected." });
  if (!symbolId) return res.status(400).json({ error: "symbolId required." });
  try {
    await subscribeSymbol(connection, accountId, symbolId);
    res.json({ status: "switched", symbolId });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

const PERIOD_MAP = { "60": "M1", "300": "M5", "900": "M15", "3600": "H1" };

app.get("/api/trendbars/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  const symbolId = req.query.symbolId;
  const periodSeconds = req.query.period || "60";
  const connection = connections[accountId];
  if (!connection) return res.status(400).json({ error: "Account not connected." });
  if (!symbolId) return res.status(400).json({ error: "symbolId required." });

  const period = PERIOD_MAP[periodSeconds] || "M1";
  const toTs = Date.now();
  const fromTs = toTs - (200 * parseInt(periodSeconds, 10) * 1000);

  try {
    const data = await connection.sendCommand("ProtoOAGetTrendbarsReq", {
      ctidTraderAccountId: accountId,
      symbolId: symbolId,
      period: period,
      fromTimestamp: fromTs,
      toTimestamp: toTs,
    });
    const bars = data.trendbar || [];
    const candles = bars.map(b => {
      const low = parseFloat(b.low) / 100000;
      const open = low + (parseFloat(b.deltaOpen || 0) / 100000);
      const high = low + (parseFloat(b.deltaHigh || 0) / 100000);
      const close = low + (parseFloat(b.deltaClose || 0) / 100000);
      const time = parseInt(b.utcTimestampInMinutes, 10) * 60;
      return { time, open, high, low, close };
    }).sort((a, b) => a.time - b.time);
    res.json({ candles });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/price/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  const cached = latestPrices[accountId];
  if (cached && cached.bid) return res.json(cached);

  const connection = connections[accountId];
  const symbolId = activeSymbolByAccount[accountId];
  if (connection && symbolId) {
    try {
      await subscribeSymbol(connection, accountId, symbolId);
    } catch (err) {
      console.log("Resubscribe attempt failed:", err.message || err);
    }
  }
  res.json(latestPrices[accountId] || {});
});

app.get("/api/last-execution/:accountId", (req, res) => {
  res.json(lastExecutions[req.params.accountId] || {});
});

app.get("/api/balance/:accountId", async (req, res) => {
  const connection = connections[req.params.accountId];
  if (!connection) return res.status(400).json({ error: "Account not connected." });
  try {
    const trader = await connection.sendCommand("ProtoOATraderReq", { ctidTraderAccountId: req.params.accountId });
    res.json(trader);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/api/positions/:accountId", async (req, res) => {
  const connection = connections[req.params.accountId];
  if (!connection) return res.status(400).json({ error: "Account not connected." });
  try {
    const data = await connection.sendCommand("ProtoOAReconcileReq", { ctidTraderAccountId: req.params.accountId });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/trade", async (req, res) => {
  const { accountId, symbolId, side, volume } = req.body;
  const connection = connections[accountId];
  if (!connection) return res.status(400).json({ error: "Account not connected." });
  lastExecutions[accountId] = null;
  try {
    const order = await connection.sendCommand("ProtoOANewOrderReq", {
      ctidTraderAccountId: accountId, symbolId, orderType: "MARKET", tradeSide: side, volume: volume * 10000000,
    });
    res.json({ sent: true, ackResponse: order });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`Meridian FX Pro running on port ${PORT}`));
