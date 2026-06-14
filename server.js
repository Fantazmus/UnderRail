import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const UNDERRAIL_STATUS_CACHE_TTL_MS = clampInteger(process.env.UNDERRAIL_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const UNDERRAIL_STEAM_APP_ID = 250520;
const UNDERRAIL_STEAM_URL = "https://store.steampowered.com/app/250520/UnderRail/";
const UNDERRAIL_COMMUNITY_URL = "https://steamcommunity.com/app/250520/";
const UNDERRAIL_DISCUSSIONS_URL = "https://steamcommunity.com/app/250520/discussions/";
const UNDERRAIL_GUIDES_URL = "https://steamcommunity.com/app/250520/guides/";
const UNDERRAIL_NEWS_URL = "https://store.steampowered.com/news/app/250520";
const UNDERRAIL_FORUM_URL = "https://stygiansoftware.com/forums/";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "falloutfanatics-underrail-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = UNDERRAIL_STEAM_APP_ID) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let payload;

      try {
        const response = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
          {
            redirect: "follow",
            signal: controller.signal
          }
        );

        if (!response.ok) {
          throw new Error(`Steam current players API returned HTTP ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }

      return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
    } catch (error) {
      lastError = error;

      if (attempt < 1) {
        await sleep(350);
      }
    }
  }

  throw lastError || new Error("Steam current players API request failed.");
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getUnderrailStatusPayload() {
  const cacheKey = "underrail:status";
  const cached = getCachedPayload(cacheKey, UNDERRAIL_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [
    steamPlayersResult,
    steamStorePageResult,
    communityPageResult,
    discussionsPageResult,
    forumPageResult,
    guidesPageResult,
    newsPageResult
  ] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(UNDERRAIL_STEAM_URL, "UnderRail Steam store page"),
    fetchPageStatus(UNDERRAIL_COMMUNITY_URL, "UnderRail Steam community page"),
    fetchPageStatus(UNDERRAIL_DISCUSSIONS_URL, "UnderRail Steam discussions page"),
    fetchPageStatus(UNDERRAIL_FORUM_URL, "UnderRail official forum"),
    fetchPageStatus(UNDERRAIL_GUIDES_URL, "UnderRail guides page"),
    fetchPageStatus(UNDERRAIL_NEWS_URL, "UnderRail news page")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const steamStorePage = steamStorePageResult.status === "fulfilled" ? steamStorePageResult.value : null;
  const steamStorePageError = steamStorePageResult.status === "rejected"
    ? sanitizeDisplayText(steamStorePageResult.reason?.message || "Steam store request failed.", 180)
    : "";

  const communityPage = communityPageResult.status === "fulfilled" ? communityPageResult.value : null;
  const communityPageError = communityPageResult.status === "rejected"
    ? sanitizeDisplayText(communityPageResult.reason?.message || "Steam community request failed.", 180)
    : "";

  const discussionsPage = discussionsPageResult.status === "fulfilled" ? discussionsPageResult.value : null;
  const discussionsPageError = discussionsPageResult.status === "rejected"
    ? sanitizeDisplayText(discussionsPageResult.reason?.message || "Steam discussions request failed.", 180)
    : "";

  const forumPage = forumPageResult.status === "fulfilled" ? forumPageResult.value : null;
  const forumPageError = forumPageResult.status === "rejected"
    ? sanitizeDisplayText(forumPageResult.reason?.message || "Official forum request failed.", 180)
    : "";

  const guidesPage = guidesPageResult.status === "fulfilled" ? guidesPageResult.value : null;
  const guidesPageError = guidesPageResult.status === "rejected"
    ? sanitizeDisplayText(guidesPageResult.reason?.message || "Guides page request failed.", 180)
    : "";

  const newsPage = newsPageResult.status === "fulfilled" ? newsPageResult.value : null;
  const newsPageError = newsPageResult.status === "rejected"
    ? sanitizeDisplayText(newsPageResult.reason?.message || "News page request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: UNDERRAIL_STEAM_URL,
      title: "UnderRail on Steam",
      description: "Текущий онлайн UnderRail в Steam. Это число игроков в PC Steam, а не какой-либо общий серверный онлайн.",
      note: steamPlayersError ? "Steam временно не отдал число игроков." : "Число игроков получено из официального Steam current players API."
    },
    {
      key: "steam-store",
      kind: "store",
      name: "Страница Steam",
      sourceLabel: "Steam Store",
      status: getStateFromStatus(Boolean(steamStorePage?.ok)),
      value: steamStorePage?.status ?? null,
      valueLabel: toHttpValueLabel(steamStorePage?.status ?? null),
      httpStatus: steamStorePage?.status ?? null,
      url: steamStorePage?.url || UNDERRAIL_STEAM_URL,
      title: "UnderRail on Steam",
      description: "Основная страница UnderRail в Steam с описанием игры, системными требованиями и обновлениями магазина.",
      note: steamStorePageError ? "Страница Steam временно не ответила." : (steamStorePage?.ok ? "Страница Steam доступна." : "Страница Steam сейчас не подтвердила корректный ответ.")
    },
    {
      key: "steam-community",
      kind: "community",
      name: "Центр сообщества",
      sourceLabel: "Steam Community",
      status: getStateFromStatus(Boolean(communityPage?.ok)),
      value: communityPage?.status ?? null,
      valueLabel: toHttpValueLabel(communityPage?.status ?? null),
      httpStatus: communityPage?.status ?? null,
      url: communityPage?.url || UNDERRAIL_COMMUNITY_URL,
      title: "UnderRail Community Hub",
      description: "Центр сообщества Steam для UnderRail: обсуждения, руководства, скриншоты и активность игроков.",
      note: communityPageError ? "Центр сообщества временно не ответил." : (communityPage?.ok ? "Центр сообщества доступен." : "Центр сообщества сейчас не подтвердил корректный ответ.")
    },
    {
      key: "steam-discussions",
      kind: "community",
      name: "Обсуждения Steam",
      sourceLabel: "Steam Discussions",
      status: getStateFromStatus(Boolean(discussionsPage?.ok)),
      value: discussionsPage?.status ?? null,
      valueLabel: toHttpValueLabel(discussionsPage?.status ?? null),
      httpStatus: discussionsPage?.status ?? null,
      url: discussionsPage?.url || UNDERRAIL_DISCUSSIONS_URL,
      title: "Steam Community :: UnderRail Discussions",
      description: "Раздел обсуждений UnderRail в Steam Community с вопросами, ответами и советами игроков.",
      note: discussionsPageError ? "Раздел обсуждений временно не ответил." : (discussionsPage?.ok ? "Раздел обсуждений доступен." : "Раздел обсуждений сейчас не подтвердил корректный ответ.")
    },
    {
      key: "official-forum",
      kind: "forum",
      name: "Официальный форум",
      sourceLabel: "Stygian Forums",
      status: getStateFromStatus(Boolean(forumPage?.ok)),
      value: forumPage?.status ?? null,
      valueLabel: toHttpValueLabel(forumPage?.status ?? null),
      httpStatus: forumPage?.status ?? null,
      url: forumPage?.url || UNDERRAIL_FORUM_URL,
      title: "Stygian Software Forum",
      description: "Официальный форум Stygian Software по UnderRail с обсуждениями, патчами, вопросами игроков и сообщениями разработчиков.",
      note: forumPageError ? "Официальный форум временно не ответил." : (forumPage?.ok ? "Официальный форум доступен." : "Официальный форум сейчас не подтвердил корректный ответ.")
    },
    {
      key: "guides-page",
      kind: "guide",
      name: "Гайды сообщества",
      sourceLabel: "Steam Guides",
      status: getStateFromStatus(Boolean(guidesPage?.ok)),
      value: guidesPage?.status ?? null,
      valueLabel: toHttpValueLabel(guidesPage?.status ?? null),
      httpStatus: guidesPage?.status ?? null,
      url: guidesPage?.url || UNDERRAIL_GUIDES_URL,
      title: "Steam Community :: UnderRail Guides",
      description: "Подборка пользовательских гайдов и советов по UnderRail в Steam Community.",
      note: guidesPageError ? "Раздел гайдов временно не ответил." : (guidesPage?.ok ? "Раздел гайдов доступен." : "Раздел гайдов сейчас не подтвердил корректный ответ.")
    },
    {
      key: "news-page",
      kind: "news",
      name: "Новости игры",
      sourceLabel: "Steam News",
      status: getStateFromStatus(Boolean(newsPage?.ok)),
      value: newsPage?.status ?? null,
      valueLabel: toHttpValueLabel(newsPage?.status ?? null),
      httpStatus: newsPage?.status ?? null,
      url: newsPage?.url || UNDERRAIL_NEWS_URL,
      title: "UnderRail - Steam News Hub",
      description: "Лента новостей и обновлений UnderRail в Steam.",
      note: newsPageError ? "Раздел новостей временно не ответил." : (newsPage?.ok ? "Раздел новостей доступен." : "Раздел новостей сейчас не подтвердил корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "falloutfanatics-underrail-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "UnderRail — одиночная изометрическая постапокалиптическая RPG от Stygian Software. Эта страница показывает реальный Steam онлайн и доступность ключевых публичных страниц по игре.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics UnderRail API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-underrail-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/underrail-status", async (_req, res) => {
  try {
    const payload = await getUnderrailStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "UNDERRAIL_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build UnderRail status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`UnderRail API listening on http://${HOST}:${PORT}`);
});
