import { fileURLToPath } from "node:url";
import { runBookingSmoke } from "./smoke-booking.mjs";
import { runDiscoverySmoke } from "./smoke-discovery.mjs";

export async function runAllSmokes() {
  const discovery = await runDiscoverySmoke();
  const booking = await runBookingSmoke();

  return {
    discovery,
    booking,
  };
}

async function main() {
  const result = await runAllSmokes();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
