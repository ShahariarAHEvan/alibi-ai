import { loadDotEnv } from "./env.js";
loadDotEnv();
const { createApp } = await import("./app.js");

const port = Number(process.env.PORT || 3000);
const { server } = createApp();
server.listen(port, () => {
  const live = process.env.LLM_API_KEY ? "LIVE AI" : "SCRIPTED (no LLM_API_KEY set)";
  const pay = process.env.PAYPAL_CLIENT_ID ? "PayPal sandbox configured" : "PayPal NOT configured (solo demo only)";
  console.log(`Alibi AI running at http://localhost:${port}`);
  console.log(`Witness mode: ${live}`);
  console.log(`Payments: ${pay}`);
});
