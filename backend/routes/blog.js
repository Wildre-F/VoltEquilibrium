const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

// Cache blog articles for 2 hours
let blogCache = null;
let blogCachedAt = 0;
const BLOG_CACHE_TTL = 2 * 60 * 60 * 1000;

// RSS feeds from green energy sources
const RSS_FEEDS = [
  "https://cleantechnica.com/feed/",
  "https://www.renewableenergyworld.com/feed/",
  "https://reneweconomy.com.au/feed/",
];

// GET /articles - fetch green energy blog articles
router.get("/articles", async (req, res) => {
  try {
    // Return cache if fresh
    if (blogCache && Date.now() - blogCachedAt < BLOG_CACHE_TTL) {
      return res.json({ success: true, data: blogCache, cached: true });
    }

    const articles = [];

    // Try each feed, take first that works
    for (const feedUrl of RSS_FEEDS) {
      try {
        const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feedUrl)}&count=6`;
        const response = await fetch(apiUrl, { timeout: 8000 });
        const data = await response.json();

        if (data.status === "ok" && data.items?.length > 0) {
          for (const item of data.items) {
            articles.push({
              title: item.title,
              description: (item.description || "").replace(/<[^>]*>/g, "").slice(0, 150) + "...",
              link: item.link,
              pubDate: item.pubDate,
              source: data.feed?.title || "Green Energy News",
              thumbnail: item.thumbnail || item.enclosure?.link || null,
            });
          }
          break; // Got articles, stop trying other feeds
        }
      } catch (feedErr) {
        console.error(`[blog] Feed failed: ${feedUrl}`, feedErr.message);
        continue; // Try next feed
      }
    }

    // Fallback static articles if all feeds fail
    if (articles.length === 0) {
      articles.push(
        { title: "How Solar Panels Work: A Simple Guide", description: "Solar panels convert sunlight into electricity using photovoltaic cells. Learn how this technology powers homes and businesses around the world.", link: "https://www.energy.gov/eere/solar/how-does-solar-work", pubDate: new Date().toISOString(), source: "U.S. Department of Energy", thumbnail: null },
        { title: "The Benefits of Community Solar Programs", description: "Community solar allows multiple people to benefit from a single solar array. Discover how shared solar projects are making clean energy accessible.", link: "https://www.energy.gov/eere/solar/community-solar-basics", pubDate: new Date().toISOString(), source: "U.S. Department of Energy", thumbnail: null },
        { title: "Understanding Battery Storage for Renewable Energy", description: "Battery storage systems help store excess solar and wind energy for later use. Learn about the latest advances in energy storage technology.", link: "https://www.energy.gov/eere/articles/how-does-battery-storage-work", pubDate: new Date().toISOString(), source: "U.S. Department of Energy", thumbnail: null },
        { title: "South Africa's Renewable Energy Future", description: "South Africa is rapidly expanding its renewable energy capacity. Explore the country's plans for solar, wind, and battery storage infrastructure.", link: "https://www.iea.org/countries/south-africa", pubDate: new Date().toISOString(), source: "International Energy Agency", thumbnail: null },
      );
    }

    blogCache = articles;
    blogCachedAt = Date.now();

    return res.json({ success: true, data: articles, cached: false });
  } catch (err) {
    console.error("[blog] Error fetching articles:", err.message);
    return res.status(500).json({ success: false, message: "Error fetching blog articles" });
  }
});

module.exports = router;
