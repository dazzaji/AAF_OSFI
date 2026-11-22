import { createShop, shopConfig } from './shop.js';
const cfg = shopConfig();
const s = await createShop(cfg);
await s.listen();
console.log(`[shop] at ${cfg.url} (mode: ${cfg.mode}), trusting ${cfg.trusted.join(', ')}`);
