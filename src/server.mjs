import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadConfig, summarizeConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { clampLimit } from "./format.mjs";
import { getCityGrounding, searchCities } from "./tools/cities.mjs";
import { getHotelGrounding, searchHotels } from "./tools/hotels.mjs";

const config = loadConfig();
const db = createDb(config);

const server = new McpServer({
  name: config.server.name,
  version: config.server.version,
});

function asTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

server.registerTool(
  "search_cities",
  {
    description: "Search tripwiki city grounding cards for agent planning and destination discovery.",
    inputSchema: {
      query: z.string().min(1).describe("City, alias, or destination keyword to search."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of cities to return."),
    },
  },
  async ({ query, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchCities(db, { query, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_city_grounding",
  {
    description: "Get a grounded destination card with structured city context and top POIs.",
    inputSchema: {
      source_city_id: z.string().optional().describe("Bitvoya / source city id."),
      tripwiki_city_id: z.string().optional().describe("Tripwiki canonical city id."),
      city_name: z.string().optional().describe("Fallback city name lookup."),
      poi_limit: z.number().int().min(1).max(20).optional().describe("Maximum nearby POIs to include."),
    },
  },
  async ({ source_city_id, tripwiki_city_id, city_name, poi_limit }) => {
    if (!source_city_id && !tripwiki_city_id && !city_name) {
      throw new Error("One of source_city_id, tripwiki_city_id, or city_name is required.");
    }

    const resolvedPoiLimit = clampLimit(poi_limit, config.limits.defaultPoi, 20);
    const payload = await getCityGrounding(
      db,
      { source_city_id, tripwiki_city_id, city_name },
      resolvedPoiLimit
    );

    if (!payload) {
      return asTextResult({
        found: false,
        reason: "No city grounding card matched the supplied identity.",
      });
    }

    return asTextResult({
      found: true,
      ...payload,
    });
  }
);

server.registerTool(
  "search_hotels",
  {
    description: "Search Bitvoya luxury hotel grounding cards by hotel name, brand, or destination.",
    inputSchema: {
      query: z.string().min(1).describe("Hotel name, brand, or destination keyword."),
      city_name: z.string().optional().describe("Optional city filter."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of hotels to return."),
    },
  },
  async ({ query, city_name, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchHotels(db, { query, city_name, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_grounding",
  {
    description: "Get a grounded Bitvoya hotel card with transport, traveler fit, and nearby POIs.",
    inputSchema: {
      source_hotel_id: z.string().optional().describe("Bitvoya / source hotel id."),
      tripwiki_hotel_id: z.string().optional().describe("Tripwiki canonical hotel id."),
      hotel_name: z.string().optional().describe("Fallback hotel name lookup."),
      poi_limit: z.number().int().min(1).max(20).optional().describe("Maximum nearby POIs to include."),
    },
  },
  async ({ source_hotel_id, tripwiki_hotel_id, hotel_name, poi_limit }) => {
    if (!source_hotel_id && !tripwiki_hotel_id && !hotel_name) {
      throw new Error("One of source_hotel_id, tripwiki_hotel_id, or hotel_name is required.");
    }

    const resolvedPoiLimit = clampLimit(poi_limit, config.limits.defaultPoi, 20);
    const payload = await getHotelGrounding(
      db,
      { source_hotel_id, tripwiki_hotel_id, hotel_name },
      resolvedPoiLimit
    );

    if (!payload) {
      return asTextResult({
        found: false,
        reason: "No hotel grounding card matched the supplied identity.",
      });
    }

    return asTextResult({
      found: true,
      ...payload,
    });
  }
);

async function main() {
  const dbStatus = await db.ping();
  console.error("bitvoya-mcp starting");
  console.error(JSON.stringify({ config: summarizeConfig(config), dbStatus }, null, 2));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown() {
  await db.close();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

main().catch(async (error) => {
  console.error("Server error:", error);
  await shutdown();
  process.exit(1);
});
